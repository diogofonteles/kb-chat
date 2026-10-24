import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ResearchEvent } from '@kb-chat/contracts';
import { z } from 'zod';
import { KB_MCP_SERVER } from '../mcp/kb-mcp-server.js';
import type {
  ResearchInput,
  ResearchRunnerPort,
} from '../ports/research-runner.js';
import type { ResearchToolsFactory } from '../ports/research-tools.js';
import { cliFailureCode } from './claude-cli-runner.js';
import {
  runCliTurn,
  type CliDialect,
  type CliLine,
  type CliLaunch,
  type CliTurnOptions,
  type TurnAccess,
} from './cli-research-turn.js';
import {
  defaultSubscriptionPrompt,
  subscriptionTurnInput,
  type SubscriptionPrompt,
} from './subscription-prompt.js';

/**
 * `codex exec --json` events (Codex CLI ≥ 0.4x, per openai/codex#4525): thread.started,
 * turn.started, item.started/updated/completed (agent_message, reasoning, mcp_tool_call),
 * turn.completed with usage, turn.failed and error. Best effort: not installed here.
 */
const lineSchema = z.looseObject({
  type: z.string(),
  item: z
    .looseObject({ type: z.string(), text: z.string().optional() })
    .optional(),
  error: z.looseObject({ message: z.string().optional() }).optional(),
});

/** Maps one stdout line of `codex exec --json` (unknown lines: nothing). */
export function parseCodexLine(text: string): CliLine {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  const parsed = lineSchema.safeParse(json);
  if (!parsed.success) return {};
  const line = parsed.data;
  if (line.type === 'turn.completed') return { result: { ok: true } };
  if (line.type === 'turn.failed')
    return {
      result: { ok: false, code: cliFailureCode(line.error?.message) },
    };
  const message =
    line.type === 'item.completed' && line.item?.type === 'agent_message'
      ? line.item.text
      : undefined;
  // Codex sends each message whole: one before a tool call is shown, then retracted when
  // the tool result arrives (ADR 0009).
  return message ? { text: `${message}\n\n` } : {};
}

export interface CodexCliRunnerOptions extends Omit<CliTurnOptions, 'model'> {
  readonly model?: string;
  readonly tools?: ResearchToolsFactory;
  /** The research rules for a topic and profile; default: defaultSubscriptionPrompt. */
  readonly systemPrompt?: SubscriptionPrompt;
}

/** The variable that carries the turn token to Codex (sent as `Authorization: Bearer`). */
export const CODEX_TOKEN_ENV = 'KB_CHAT_MCP_TOKEN';

/**
 * Best-effort lock-down (ADR 0007): the long-standing built-in tools off, no web search,
 * no AGENTS.md, no history. Codex has no switch that turns off every built-in tool, and
 * its tool set changes between versions, so the provider stays off unless the owner
 * enables it (KB_CHAT_CODEX=on).
 */
const CODEX_LOCKDOWN = [
  'features.shell_tool=false',
  'features.unified_exec=false',
  'features.view_image=false',
  'features.apply_patch_freeform=false',
  'web_search="disabled"',
  'project_doc_max_bytes=0',
  'history.persistence="none"',
] as const;

/** Read-only sandbox, no session kept, the kb tools over the turn's MCP endpoint. */
export function codexArgs(mcpUrl: string, model: string | undefined): string[] {
  const server = `mcp_servers.${KB_MCP_SERVER}`;
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    ...['--sandbox', 'read-only'],
    '--ephemeral',
    ...CODEX_LOCKDOWN.flatMap((setting) => ['-c', setting]),
    ...['-c', `${server}.url=${JSON.stringify(mcpUrl)}`],
    ...['-c', `${server}.bearer_token_env_var="${CODEX_TOKEN_ENV}"`],
    // "--model=x": a value can never be read as another flag.
    ...(model ? [`--model=${model}`] : []),
    // The prompt comes from stdin.
    '-',
  ];
}

const mtimeOf = async (path: string): Promise<number | null> =>
  stat(path).then(
    (info) => info.mtimeMs,
    () => null,
  );

/**
 * A CODEX_HOME of kb-chat's own (ADR 0007): the owner's ~/.codex/config.toml (other MCP
 * servers, profiles) is never loaded; only the login (auth.json) is copied in, again
 * whenever the owner's copy is newer (a fresh `codex login`).
 */
export async function privateCodexHome(
  workDir: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const home = join(workDir, 'home');
  await mkdir(home, { recursive: true, mode: 0o700 });
  const source = join(
    env.CODEX_HOME ?? join(env.HOME ?? homedir(), '.codex'),
    'auth.json',
  );
  const target = join(home, 'auth.json');
  const [sourceTime, targetTime] = await Promise.all([
    mtimeOf(source),
    mtimeOf(target),
  ]);
  if (sourceTime !== null && (targetTime === null || sourceTime > targetTime)) {
    await copyFile(source, target);
    await chmod(target, 0o600);
  }
  return home;
}

/** Research turns on the owner's ChatGPT plan through the Codex CLI (KBC-007 FR-4, BR-7). */
export class CodexCliRunner implements ResearchRunnerPort {
  readonly billing = 'subscription' as const;
  readonly model: string;
  private readonly dialect: CliDialect;

  constructor(private readonly options: CodexCliRunnerOptions) {
    this.model = options.model ?? 'codex';
    const prompt = options.systemPrompt ?? defaultSubscriptionPrompt;
    this.dialect = {
      name: 'codex',
      launch: (access, input) => this.launch(access, input.model),
      // Codex has no system-prompt flag: the instructions lead the input.
      input: (input) =>
        `${prompt(input.topic, input.profile, input.canDeepen)}\n\n${subscriptionTurnInput(input.question, input.history, input.findings)}`,
      parse: parseCodexLine,
    };
  }

  configured(): boolean {
    return this.options.tools !== undefined;
  }

  private async launch(
    access: TurnAccess,
    model: string | undefined,
  ): Promise<CliLaunch> {
    const home = await privateCodexHome(this.options.workDir, this.options.env);
    return {
      args: codexArgs(access.bearerUrl, model),
      env: { CODEX_HOME: home, [CODEX_TOKEN_ENV]: access.token },
    };
  }

  async *run(input: ResearchInput): AsyncIterable<ResearchEvent> {
    const tools = this.options.tools?.(input.topic);
    if (!tools) {
      yield { type: 'error', code: 'LLM_NOT_CONFIGURED' };
      return;
    }
    if (input.signal.aborted) return;
    yield* runCliTurn({ ...this.options, model: this.model }, this.dialect, {
      ...input,
      tools,
      model: this.options.model,
    });
  }
}
