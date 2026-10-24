import type { ResearchEvent } from '@kb-chat/contracts';
import type {
  AgentChunk,
  AgentLlmPort,
  AgentMessage,
  AgentStreamOptions,
  LlmChunk,
  LlmMessage,
  LlmPort,
  LlmPrice,
  LlmStreamOptions,
  ToolDefinition,
} from '../ports/llm.js';
import type {
  ResearchInput,
  ResearchRunnerPort,
} from '../ports/research-runner.js';

export const isAgentLlm = (llm: LlmPort): llm is AgentLlmPort =>
  'streamAgent' in llm && typeof llm.streamAgent === 'function';

/**
 * An LlmPort that asks for the current provider on every call, so a change in Settings
 * applies to the next answer without a restart (KBC-007 FR-5).
 */
export class DynamicLlm implements AgentLlmPort {
  constructor(private readonly current: () => LlmPort) {}

  get model(): string {
    return this.current().model;
  }

  get billing(): LlmPort['billing'] {
    return this.current().billing;
  }

  configured(): boolean {
    return this.current().configured();
  }

  price(): Promise<LlmPrice> {
    return this.current().price();
  }

  balance(): Promise<number | null> {
    return this.current().balance();
  }

  stream(
    messages: readonly LlmMessage[],
    options: LlmStreamOptions,
  ): AsyncIterable<LlmChunk> {
    return this.current().stream(messages, options);
  }

  streamAgent(
    messages: readonly AgentMessage[],
    tools: readonly ToolDefinition[],
    options: AgentStreamOptions,
  ): AsyncIterable<AgentChunk> {
    const llm = this.current();
    if (!isAgentLlm(llm))
      throw new Error(`${llm.model} does not support tool calling`);
    return llm.streamAgent(messages, tools, options);
  }
}

/** The research runner of the current provider, resolved per turn (FR-5). */
export class DynamicResearchRunner implements ResearchRunnerPort {
  constructor(private readonly current: () => ResearchRunnerPort) {}

  get model(): string {
    return this.current().model;
  }

  get billing(): ResearchRunnerPort['billing'] {
    return this.current().billing;
  }

  configured(): boolean {
    return this.current().configured();
  }

  run(input: ResearchInput): AsyncIterable<ResearchEvent> {
    return this.current().run(input);
  }
}

/** No provider able to research: the route refuses with LLM_NOT_CONFIGURED. */
export class DisabledResearchRunner implements ResearchRunnerPort {
  readonly model = 'none';
  readonly billing = 'per-token' as const;

  configured(): boolean {
    return false;
  }

  async *run(): AsyncIterable<ResearchEvent> {
    yield { type: 'error', code: 'LLM_NOT_CONFIGURED' };
  }
}
