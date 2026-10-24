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
} from './cli-research-turn.js';
import {
  SUBSCRIPTION_RESEARCH_PROMPT,
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
      delta: z
        .looseObject({ type: z.string(), text: z.string().optional() })
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
    const delta = line.type === 'stream_event' ? line.event.delta : undefined;
    const text = delta?.type === 'text_delta' ? delta.text : undefined;
    const events: ResearchEvent[] = text ? [{ type: 'token', text }] : [];
    return { events };
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
  readonly systemPrompt?: string;
}

/** The arguments of a research turn: only the kb MCP tools, no built-ins, no user settings. */
export function claudeArgs(
  mcpUrl: string,
  options: Pick<ClaudeCliRunnerOptions, 'model' | 'systemPrompt'>,
): string[] {
  const mcpConfig = JSON.stringify({
    mcpServers: { [KB_MCP_SERVER]: { type: 'http', url: mcpUrl } },
  });
  return [
    '-p',
    ...['--output-format', 'stream-json', '--verbose'],
    '--include-partial-messages',
    ...['--tools', ''],
    ...['--allowedTools', `mcp__${KB_MCP_SERVER}`],
    ...['--mcp-config', mcpConfig, '--strict-mcp-config'],
    ...['--setting-sources', ''],
    '--no-session-persistence',
    ...['--permission-prompts', 'none'],
    ...[
      '--system-prompt',
      options.systemPrompt ?? SUBSCRIPTION_RESEARCH_PROMPT,
    ],
    ...(options.model ? ['--model', options.model] : []),
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
    this.dialect = {
      name: 'claude',
      args: (url) => claudeArgs(url, options),
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
