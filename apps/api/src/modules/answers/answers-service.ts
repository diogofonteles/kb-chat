import type {
  AnswerEstimate,
  AnswerEvent,
  AnswerRequest,
  AnswerSource,
} from '@kb-chat/contracts';
import { answerRequestSchema } from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  LlmChunk,
  LlmMessage,
  LlmPort,
  LlmUsage,
} from '../../ports/llm.js';
import type { SpendLedgerPort } from '../../ports/spend-ledger.js';
import type { VaultReaderPort } from '../../ports/vault-reader.js';
import { splitFrontmatter } from '../catalog/index.js';
import type { SearchService } from '../search/index.js';
import {
  MAX_PASSAGES,
  extractPassage,
  questionTerms,
  type Passage,
} from './passages.js';
import { buildMessages } from './prompt.js';

/** Longest answer requested from the model (ADR 0004). */
export const MAX_OUTPUT_TOKENS = 1000;
const CHARS_PER_TOKEN = 3.5;
const REPLAY_TTL_MS = 10 * 60_000;

export interface AnswersServiceDeps {
  readonly search: SearchService;
  readonly vault: VaultReaderPort;
  readonly llm: LlmPort;
  readonly ledger: SpendLedgerPort;
  readonly dailyCapUsd: number;
  /** Who spends (ADR 0005: the owner until release 2 adds logins). */
  readonly principal: string;
}

export interface PreparedAnswer {
  readonly messages: readonly LlmMessage[];
  readonly sources: readonly AnswerSource[];
  readonly estimateUsd: number;
}

const tokensOf = (text: string): number =>
  Math.ceil(text.length / CHARS_PER_TOKEN);

interface RunState {
  text: string;
  usage: LlmUsage | null;
}

async function* collect(
  chunks: AsyncIterable<LlmChunk>,
  run: RunState,
): AsyncIterable<string> {
  for await (const chunk of chunks) {
    if (chunk.type === 'usage') run.usage = chunk.usage;
    else yield ((run.text += chunk.text), chunk.text);
  }
}

export class AnswersService {
  private readonly replays = new Map<
    string,
    { events: AnswerEvent[]; at: number }
  >();

  constructor(private readonly deps: AnswersServiceDeps) {}

  async estimate(
    topic: string,
    request: AnswerRequest,
  ): Promise<AnswerEstimate> {
    this.requireConfigured();
    const prepared = await this.prepare(topic, request);
    return {
      usd: prepared.estimateUsd,
      model: this.deps.llm.model,
      passages: prepared.sources.length,
    };
  }

  /** Builds the grounded prompt and refuses before any spend (key, cap, credit). */
  async prepare(
    topic: string,
    request: AnswerRequest,
  ): Promise<PreparedAnswer> {
    this.requireConfigured();
    const { q, mode, filters } = answerRequestSchema.parse(request);
    const passages = await this.passages(topic, { q, mode, filters });
    const messages = buildMessages(q, passages);
    const price = await this.deps.llm.price();
    const inputTokens = tokensOf(messages.map((m) => m.content).join('\n'));
    const estimateUsd =
      inputTokens * price.input + MAX_OUTPUT_TOKENS * price.output;
    const sources = passages.map(({ n, id, title }) => ({ n, id, title }));
    return { messages, sources, estimateUsd };
  }

  async guardSpend(estimateUsd: number): Promise<void> {
    if (this.deps.llm.billing === 'subscription') return;
    const spent = await this.deps.ledger.spentToday(this.deps.principal);
    if (spent + estimateUsd > this.deps.dailyCapUsd)
      throw new AppError('DAILY_CAP_REACHED', 'Daily AI spend cap reached');
    const balance = await this.deps.llm.balance();
    if (balance !== null && balance < estimateUsd)
      throw new AppError('LLM_INSUFFICIENT_CREDIT', 'Insufficient credit');
  }

  replay(idempotencyKey: string): readonly AnswerEvent[] | null {
    const cached = this.replays.get(idempotencyKey);
    return cached && Date.now() - cached.at < REPLAY_TTL_MS
      ? cached.events
      : null;
  }

  /** Streams sources, tokens and the final cost; the spend is recorded even when interrupted. */
  async *stream(
    prepared: PreparedAnswer,
    options: { signal: AbortSignal; key: string },
  ): AsyncIterable<AnswerEvent> {
    const events: AnswerEvent[] = [
      { type: 'sources', sources: [...prepared.sources] },
    ];
    yield events[0] as AnswerEvent;
    const run: RunState = { text: '', usage: null };
    for await (const text of this.tokens(prepared, run, options.signal)) {
      const event: AnswerEvent = { type: 'token', text };
      events.push(event);
      yield event;
    }
    const done = await this.record(prepared, {
      ...run,
      interrupted: options.signal.aborted,
    });
    events.push(done);
    yield done;
    if (!done.interrupted)
      this.replays.set(options.key, { events, at: Date.now() });
  }

  /** Model tokens; collects the text and usage into `run`. An abort ends it quietly. */
  private async *tokens(
    prepared: PreparedAnswer,
    run: RunState,
    signal: AbortSignal,
  ): AsyncIterable<string> {
    try {
      yield* collect(
        this.deps.llm.stream(prepared.messages, {
          maxTokens: MAX_OUTPUT_TOKENS,
          signal,
        }),
        run,
      );
    } catch (err) {
      if (!signal.aborted) throw err;
    }
  }

  private async record(
    prepared: PreparedAnswer,
    run: { usage: LlmUsage | null; text: string; interrupted: boolean },
  ): Promise<Extract<AnswerEvent, { type: 'done' }>> {
    const price = await this.deps.llm.price();
    const inputTokens =
      run.usage?.inputTokens ??
      tokensOf(prepared.messages.map((m) => m.content).join('\n'));
    const outputTokens = run.usage?.outputTokens ?? tokensOf(run.text);
    const usd =
      this.deps.llm.billing === 'subscription'
        ? 0
        : (run.usage?.usd ??
          inputTokens * price.input + outputTokens * price.output);
    await this.deps.ledger.append({
      ts: new Date().toISOString(),
      principal: this.deps.principal,
      model: this.deps.llm.model,
      inputTokens,
      outputTokens,
      usd,
      interrupted: run.interrupted,
    });
    return {
      type: 'done',
      usd,
      model: this.deps.llm.model,
      interrupted: run.interrupted,
    };
  }

  private requireConfigured(): void {
    if (!this.deps.llm.configured())
      throw new AppError('LLM_NOT_CONFIGURED', 'No AI provider configured');
  }

  private async passages(
    topic: string,
    request: Pick<AnswerRequest, 'q' | 'mode' | 'filters'>,
  ): Promise<Passage[]> {
    const response = await this.deps.search.search(topic, {
      ...request,
      limit: MAX_PASSAGES,
    });
    const terms = questionTerms(request.q);
    return Promise.all(
      response.items.map(async (item, index) => {
        const text = (await this.deps.vault.readDocument(topic, item.id)) ?? '';
        const { data, body } = splitFrontmatter(text);
        const passage = extractPassage(body, terms);
        const summary =
          typeof data['summary'] === 'string'
            ? `Resumo: ${data['summary']}\n`
            : '';
        return {
          n: index + 1,
          id: item.id,
          title: item.title,
          text: `${summary}${passage}`,
        };
      }),
    );
  }
}
