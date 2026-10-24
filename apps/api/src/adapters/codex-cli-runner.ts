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
  type CliTurnOptions,
} from './cli-research-turn.js';
import {
  SUBSCRIPTION_RESEARCH_PROMPT,
  subscriptionTurnInput,
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
  // Codex sends each message whole; separate consecutive ones as paragraphs.
  const events: ResearchEvent[] = message
    ? [{ type: 'token', text: `${message}\n\n` }]
    : [];
  return { events };
}

export interface CodexCliRunnerOptions extends Omit<CliTurnOptions, 'model'> {
  readonly model?: string;
  readonly tools?: ResearchToolsFactory;
  readonly systemPrompt?: string;
}

/** Read-only sandbox, no session kept, the kb tools over the turn's MCP endpoint. */
export function codexArgs(mcpUrl: string, model: string | undefined): string[] {
  return [
    'exec',
    '--json',
    '--skip-git-repo-check',
    ...['--sandbox', 'read-only'],
    '--ephemeral',
    ...['-c', `mcp_servers.${KB_MCP_SERVER}.url=${JSON.stringify(mcpUrl)}`],
    ...(model ? ['--model', model] : []),
    // The prompt comes from stdin.
    '-',
  ];
}

/** Research turns on the owner's ChatGPT plan through the Codex CLI (KBC-007 FR-4, BR-7). */
export class CodexCliRunner implements ResearchRunnerPort {
  readonly billing = 'subscription' as const;
  readonly model: string;
  private readonly dialect: CliDialect;

  constructor(private readonly options: CodexCliRunnerOptions) {
    this.model = options.model ?? 'codex';
    const prompt = options.systemPrompt ?? SUBSCRIPTION_RESEARCH_PROMPT;
    this.dialect = {
      name: 'codex',
      args: (url) => codexArgs(url, options.model),
      // Codex has no system-prompt flag: the instructions lead the input.
      input: (input) =>
        `${prompt}\n\n${subscriptionTurnInput(input.question, input.history)}`,
      parse: parseCodexLine,
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
