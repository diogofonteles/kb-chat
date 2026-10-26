import { randomBytes } from 'node:crypto';
import { MAX_TOOL_STEPS } from '../modules/research/index.js';
import type { ToolDefinition } from '../ports/llm.js';
import type {
  ResearchToolResult,
  ResearchToolsPort,
} from '../ports/research-tools.js';
import type { KbMcpHooks } from './kb-mcp-server.js';

/** The deep profile's step cap, as in the in-API loop (ADR 0006: 15 tool steps per answer). */
export const MAX_TURN_STEPS = MAX_TOOL_STEPS;
/**
 * A turn that was never closed (a crashed CLI) stops answering after this; long enough
 * for an exhaustive turn (KBC-017: 30 minutes of research plus the CLI's own pace).
 */
const TURN_TTL_MS = 90 * 60_000;

/** Said to the CLI when the turn's step budget is spent (its profile's, KBC-011). */
export const stepCapText = (maxSteps: number): string =>
  `Limite de ${maxSteps} passos atingido. Não chame mais ferramentas: responda agora com o que já encontrou e diga o que faltou.`;

export interface McpTurn {
  readonly tools: ResearchToolsPort;
  readonly hooks: KbMcpHooks;
}

export interface OpenedTurn {
  /** Unguessable path segment of this turn's MCP endpoint. */
  readonly token: string;
  close(): void;
}

/** Counts the turn's tool calls and refuses past the step cap (the CLI runs its own loop). */
class CappedTools implements ResearchToolsPort {
  private steps = 0;

  constructor(
    private readonly inner: ResearchToolsPort,
    private readonly maxSteps: number,
  ) {}

  definitions(): readonly ToolDefinition[] {
    return this.inner.definitions();
  }

  async call(name: string, args: unknown): Promise<ResearchToolResult> {
    this.steps += 1;
    if (this.steps > this.maxSteps) throw new Error(stepCapText(this.maxSteps));
    return this.inner.call(name, args);
  }
}

/**
 * The research turns served over MCP to a subscription CLI (ADR 0007). Each turn gets a
 * random token; the endpoint answers only while the turn is open.
 */
export class McpTurnRegistry {
  private readonly turns = new Map<string, McpTurn>();

  open(
    tools: ResearchToolsPort,
    hooks: KbMcpHooks,
    maxSteps = MAX_TURN_STEPS,
  ): OpenedTurn {
    const token = randomBytes(24).toString('base64url');
    this.turns.set(token, { tools: new CappedTools(tools, maxSteps), hooks });
    const timer = setTimeout(() => this.turns.delete(token), TURN_TTL_MS);
    timer.unref();
    return {
      token,
      close: () => {
        clearTimeout(timer);
        this.turns.delete(token);
      },
    };
  }

  get(token: string): McpTurn | undefined {
    return this.turns.get(token);
  }

  get size(): number {
    return this.turns.size;
  }
}
