import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AiTestCode, ResearchEvent } from '@kb-chat/contracts';
import { z } from 'zod';
import { KB_MCP_SERVER } from '../mcp/kb-mcp-server.js';
import type {
  ResearchInput,
  ResearchRunnerPort,
} from '../ports/research-runner.js';
import type { ResearchToolsFactory } from '../ports/research-tools.js';
import {
  runCliTurn,
  type CliDialect,
  type CliLine,
  type CliTurnOptions,
  type TurnAccess,
} from './cli-research-turn.js';
import {
  defaultSubscriptionPrompt,
  subscriptionTurnInput,
} from './subscription-prompt.js';

/** Claude Code's `--output-format stream-json` lines that matter here (verified on 2.1.x). */
const lineSchema = z.discriminatedUnion('type', [
  z.looseObject({
    type: z.literal('system'),
    subtype: z.string(),
    model: z.string().optional(),
  }),
  z.looseObject({
    type: z.literal('stream_event'),
    event: z.looseObject({
      type: z.string(),
      // text_delta in content_block_delta; stop_reason (no type) in message_delta.
      delta: z
        .looseObject({
          type: z.string().optional(),
          text: z.string().optional(),
          stop_reason: z.string().nullable().optional(),
        })
        .optional(),
    }),
  }),
  z.looseObject({
    type: z.literal('result'),
    subtype: z.string(),
    is_error: z.boolean().optional(),
    result: z.string().optional(),
  }),
]);
type ClaudeLine = z.infer<typeof lineSchema>;

const LOGIN_HINT = /log ?in|authenticat|invalid api key|oauth/i;

export const cliFailureCode = (text: string | undefined): AiTestCode =>
  LOGIN_HINT.test(text ?? '') ? 'CLI_LOGIN_REQUIRED' : 'PROVIDER_UNAVAILABLE';

const PARSERS: Record<ClaudeLine['type'], (line: ClaudeLine) => CliLine> = {
  system: (line) =>
    line.type === 'system' && line.subtype === 'init' && line.model
      ? { model: line.model }
      : {},
  stream_event: (line) => {
    if (line.type !== 'stream_event') return {};
    const { type, delta } = line.event;
    if (type === 'message_delta' && delta?.stop_reason)
      return {
        messageEnd: delta.stop_reason === 'tool_use' ? 'tool_use' : 'answer',
      };
    return delta?.type === 'text_delta' && delta.text
      ? { text: delta.text }
      : {};
  },
  result: (line) => {
    if (line.type !== 'result') return {};
    const ok = line.subtype === 'success' && line.is_error !== true;
    return ok
      ? { result: { ok: true } }
      : { result: { ok: false, code: cliFailureCode(line.result) } };
  },
};

/** Maps one stdout line of `claude -p --output-format stream-json` (unknown lines: nothing). */
export function parseClaudeLine(text: string): CliLine {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {};
  }
  const parsed = lineSchema.safeParse(json);
  return parsed.success ? PARSERS[parsed.data.type](parsed.data) : {};
}

export interface ClaudeCliRunnerOptions extends Omit<CliTurnOptions, 'model'> {
  /** An alias ("opus", "sonnet", "fable") or a full model name; default: the CLI's. */
  readonly model?: string;
  readonly tools?: ResearchToolsFactory;
  /** The research rules for a topic; default: defaultSubscriptionPrompt. */
  readonly systemPrompt?: (topic: string) => string;
}

/**
 * Writes the turn's MCP config into its private folder (0600): the URL carries the turn
 * token, which must not show in `ps` through argv.
 */
export async function writeClaudeMcpConfig(
  access: TurnAccess,
): Promise<string> {
  const path = join(access.dir, 'mcp.json');
  const config = {
    mcpServers: { [KB_MCP_SERVER]: { type: 'http', url: access.url } },
  };
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

/** The arguments of a research turn: only the kb MCP tools, no built-ins, no user settings. */
export function claudeArgs(
  mcpConfigPath: string,
  options: { readonly model?: string; readonly systemPrompt: string },
): string[] {
  return [
    '-p',
    ...['--output-format', 'stream-json', '--verbose'],
    '--include-partial-messages',
    ...['--tools', ''],
    ...['--allowedTools', `mcp__${KB_MCP_SERVER}`],
    ...['--mcp-config', mcpConfigPath, '--strict-mcp-config'],
    ...['--setting-sources', ''],
    '--no-session-persistence',
    ...['--permission-prompts', 'none'],
    ...['--system-prompt', options.systemPrompt],
    // "--model=x": a value can never be read as another flag.
    ...(options.model ? [`--model=${options.model}`] : []),
  ];
}

/**
 * Research turns on the owner's Claude subscription through Claude Code (KBC-007 FR-4,
 * BR-7): the CLI runs the tool loop itself over MCP; kb-chat never sees a credential and
 * starts it without ANTHROPIC_API_KEY, so usage counts on the plan, not on the API.
 */
export class ClaudeCliRunner implements ResearchRunnerPort {
  readonly billing = 'subscription' as const;
  readonly model: string;
  private readonly dialect: CliDialect;

  constructor(private readonly options: ClaudeCliRunnerOptions) {
    this.model = options.model ?? 'claude-code';
    const prompt = options.systemPrompt ?? defaultSubscriptionPrompt;
    this.dialect = {
      name: 'claude',
      launch: async (access, input) => ({
        args: claudeArgs(await writeClaudeMcpConfig(access), {
          model: options.model,
          systemPrompt: prompt(input.topic),
        }),
      }),
      input: (input) => subscriptionTurnInput(input.question, input.history),
      parse: parseClaudeLine,
    };
  }

  configured(): boolean {
    return this.options.tools !== undefined;
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
    });
  }
}
