import type { ProposalFailure } from '@kb-chat/contracts';
import type { LlmMessage, LlmPort, LlmUsage } from '../../ports/llm.js';
import type { TrackProposalStorePort } from '../../ports/track-proposal-store.js';
import { tokensOf } from '../spend/index.js';
import type { PreviousTrack } from './prompt.js';
import {
  MAX_OUTPUT_TOKENS,
  callCeiling,
  windowMessages,
  type ProposalPlan,
} from './proposal-plan.js';
import {
  acceptTracks,
  acceptVoices,
  parseWindowReply,
  type AcceptedTracks,
  type LastTrack,
  type WindowReply,
} from './proposal-validation.js';

/** A stalled provider must not hold a run forever (KBC-067 FR-5: "tempo esgotado"). */
export const CALL_TIMEOUT_MS = 120_000;
/** One more try for a window whose answer could not be read (FR-2). */
const ATTEMPTS = 2;

/** Ends a run before its windows are done, with the reason the person sees (FR-5). */
export class ProposalStop extends Error {
  constructor(readonly failure: ProposalFailure) {
    super(`proposal stopped: ${failure}`);
    this.name = 'ProposalStop';
  }
}

export interface WindowRunnerDeps {
  readonly runId: string;
  readonly plan: ProposalPlan;
  readonly llm: LlmPort;
  readonly store: TrackProposalStorePort;
  readonly runCapUsd: number;
  /** Aborted when the API stops. */
  readonly signal: AbortSignal;
}

/** How a run ended: no failure when every window was written. */
export interface RunOutcome {
  readonly failure: ProposalFailure | null;
  readonly spentUsd: number;
  readonly error?: unknown;
}

const retryMessage = (answer: string, error: string): LlmMessage => ({
  role: 'user',
  content: `Sua resposta anterior foi:\n${answer}\n\nA resposta tem problemas: ${error}. Corrija e responda de novo só com o JSON completo da janela.`,
});

/**
 * Runs a proposal window by window (KBC-067 FR-2, FR-3): each window is asked, read,
 * checked and written before the next, with the tracks of the window before as context.
 */
export class WindowRunner {
  private spentUsd = 0;
  private last: LastTrack | null = null;
  private previous: PreviousTrack[] = [];

  constructor(private readonly deps: WindowRunnerDeps) {}

  async run(): Promise<RunOutcome> {
    try {
      for (const index of this.deps.plan.windows.keys())
        await this.runWindow(index);
      return { failure: null, spentUsd: this.spentUsd };
    } catch (error) {
      const failure = this.failureOf(error);
      return { failure, spentUsd: this.spentUsd, error };
    }
  }

  private failureOf(error: unknown): ProposalFailure {
    if (error instanceof ProposalStop) return error.failure;
    return this.deps.signal.aborted ? 'interrupted' : 'provider';
  }

  private async runWindow(index: number): Promise<void> {
    const { plan, store, runId } = this.deps;
    const reply = await this.ask(windowMessages(plan, index, this.previous));
    const accepted = acceptTracks(reply.faixas, {
      window: plan.windows[index] ?? [],
      last: this.last,
      kept: store.keptRanges(plan.mediaId),
      voices: plan.evidence.voices,
    });
    store.saveWindow({
      runId,
      extendLast: accepted.extendLast,
      tracks: accepted.tracks,
      voices: acceptVoices(reply.vozes, plan.evidence),
      spentUsd: this.spentUsd,
    });
    this.remember(accepted);
  }

  /** The run's last track and this window's tracks, for the next window. */
  private remember(accepted: AcceptedTracks): void {
    const newest = accepted.tracks.at(-1);
    if (newest)
      this.last = { lastSegment: newest.lastSegment, startMs: newest.startMs };
    else if (accepted.extendLast && this.last)
      this.last = {
        ...this.last,
        lastSegment: accepted.extendLast.lastSegment,
      };
    this.previous = accepted.tracks.map((track) => ({ ...track }));
  }

  /** Asks a window; an unreadable answer is asked once more with what was wrong. */
  private async ask(messages: readonly LlmMessage[]): Promise<WindowReply> {
    let conversation = [...messages];
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      const answer = await this.call(conversation);
      const parsed = parseWindowReply(answer);
      if (parsed.ok) return parsed.reply;
      conversation = [...messages, retryMessage(answer, parsed.error)];
    }
    throw new ProposalStop('invalid-output');
  }

  /** One call, refused before it starts when it could cross the run's cap (BR-3). */
  private async call(messages: readonly LlmMessage[]): Promise<string> {
    const { llm, plan, runCapUsd, signal } = this.deps;
    if (this.spentUsd + callCeiling(messages, plan.price) > runCapUsd)
      throw new ProposalStop('run-cap');
    let answer = '';
    let usage: LlmUsage | null = null;
    const stream = llm.stream(messages, {
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
    });
    for await (const chunk of stream)
      if (chunk.type === 'token') answer += chunk.text;
      else usage = chunk.usage;
    this.spentUsd += this.costOf({ messages, answer, usage });
    return answer;
  }

  /** The provider's real cost; priced from the list when it reports none. */
  private costOf(call: {
    readonly messages: readonly LlmMessage[];
    readonly answer: string;
    readonly usage: LlmUsage | null;
  }): number {
    const { price } = this.deps.plan;
    if (call.usage?.usd != null) return call.usage.usd;
    const input =
      call.usage?.inputTokens ??
      tokensOf(call.messages.map((message) => message.content).join('\n'));
    const output = call.usage?.outputTokens ?? tokensOf(call.answer);
    return input * price.input + output * price.output;
  }
}
