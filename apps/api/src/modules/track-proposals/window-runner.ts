import type { ProposalFailure } from '@kb-chat/contracts';
import type {
  LlmChunk,
  LlmMessage,
  LlmPort,
  LlmUsage,
} from '../../ports/llm.js';
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
  /** What the failed runs before this one spent: the cap holds over the whole analysis. */
  readonly carriedUsd: number;
  /**
   * The value the person accepted for this run (KBC-112 BR-1): its calls, a window asked
   * again included, never add up past it. Earlier attempts do not count against it (BR-4).
   */
  readonly acceptedUsd: number;
  /** Aborted when the API stops. */
  readonly signal: AbortSignal;
  readonly onWindowSaved?: (mediaId: string) => void;
}

/** How a run ended: no failure when every window was written. */
export interface RunOutcome {
  readonly failure: ProposalFailure | null;
  readonly spentUsd: number;
  readonly error?: unknown;
}

/** What a call's stream gave so far. */
interface StreamRead {
  answer: string;
  usage: LlmUsage | null;
  started: boolean;
}

const retryMessage = (answer: string, error: string): LlmMessage => ({
  role: 'user',
  content: `Sua resposta anterior foi:\n${answer}\n\nA resposta tem problemas: ${error}. Corrija e responda de novo só com o JSON completo da janela.`,
});

/**
 * Runs a proposal window by window (KBC-067 FR-2, FR-3): each window is asked, read,
 * checked and written before the next, with the tracks of the window before as context. A
 * run that goes on from a failed one starts where it stopped, from what it left (KBC-072).
 */
export class WindowRunner {
  private spentUsd = 0;
  private last: LastTrack | null = null;
  private previous: PreviousTrack[] = [];

  constructor(private readonly deps: WindowRunnerDeps) {}

  async run(): Promise<RunOutcome> {
    try {
      const { windows, fromWindow } = this.deps.plan;
      this.restore(fromWindow);
      for (let index = fromWindow; index < windows.length; index++)
        await this.runWindow(index);
      return { failure: null, spentUsd: this.spentUsd };
    } catch (error) {
      const failure = this.failureOf(error);
      return { failure, spentUsd: this.spentUsd, error };
    }
  }

  /** What the run carried stands for the windows it did not ask. */
  private restore(fromWindow: number): void {
    if (fromWindow === 0) return;
    const tracks = this.deps.store.runTracks(this.deps.runId);
    const window = this.deps.plan.windows[fromWindow - 1] ?? [];
    const firstId = window[0]?.id ?? 0;
    const lastId = window.at(-1)?.id ?? 0;
    this.previous = tracks.flatMap(
      ({ firstSegment, lastSegment, kind, title }) =>
        firstSegment !== null &&
        lastSegment !== null &&
        firstSegment >= firstId &&
        firstSegment <= lastId
          ? [{ firstSegment, lastSegment, kind, title }]
          : [],
    );
    // The newest track before the window it goes on from: a carried one further on is not it.
    // When that one was cut (no segments), the resume does not reach back to an earlier one:
    // the window's first track starts on its own and may cut the end of the cut one again,
    // which a proposal allows (`replaceCarried`).
    const fromMs = this.deps.plan.windows[fromWindow]?.[0]?.startMs ?? Infinity;
    const newest = tracks.filter(({ startMs }) => startMs < fromMs).at(-1);
    // A person's change stays theirs: a new window does not stretch it.
    if (newest && !newest.edited && newest.lastSegment !== null)
      this.last = {
        lastSegment: newest.lastSegment,
        startMs: newest.startMs,
        endMs: newest.endMs,
      };
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
    const extended = store.saveWindow({
      runId,
      extendLast: accepted.extendLast,
      tracks: accepted.tracks,
      voices: acceptVoices(reply.vozes, plan.evidence),
      spentUsd: Math.min(this.spentUsd, this.deps.acceptedUsd),
    });
    this.deps.onWindowSaved?.(plan.mediaId);
    this.remember(accepted, extended);
  }

  /**
   * The run's last track and this window's tracks, for the next window. A continuation whose
   * track went meanwhile was not written: there is no last track left to go on from.
   */
  private remember(accepted: AcceptedTracks, extended: boolean): void {
    const newest = accepted.tracks.at(-1);
    if (newest)
      this.last = {
        lastSegment: newest.lastSegment,
        startMs: newest.startMs,
        endMs: newest.endMs,
      };
    else if (!extended) this.last = null;
    else if (accepted.extendLast && this.last)
      this.last = { ...this.last, ...accepted.extendLast };
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

  /**
   * One call, refused before it starts when its worst case could cross the run's cap (BR-3)
   * or the value accepted (KBC-112 BR-2), whichever is less: the stop names that one.
   * Compared exactly: a call that reaches the limit to the cent's fraction is made.
   */
  private async call(messages: readonly LlmMessage[]): Promise<string> {
    const { llm, plan, signal } = this.deps;
    this.assertFits(callCeiling(messages, plan.price));
    const stream = llm.stream(messages, {
      maxTokens: MAX_OUTPUT_TOKENS,
      signal: AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
    });
    const read: StreamRead = { answer: '', usage: null, started: false };
    try {
      await this.consume(stream, read);
    } catch (err) {
      // A stream that broke after it began may still be billed: count what was written.
      if (read.started) this.spentUsd += this.costOf({ messages, ...read });
      throw err;
    }
    this.spentUsd += this.costOf({ messages, ...read });
    return read.answer;
  }

  private assertFits(ceiling: number): void {
    const { runCapUsd, carriedUsd, acceptedUsd } = this.deps;
    const capLeft = runCapUsd - carriedUsd;
    if (this.spentUsd + ceiling <= Math.min(acceptedUsd, capLeft)) return;
    throw new ProposalStop(
      capLeft <= acceptedUsd ? 'run-cap' : 'accepted-limit',
    );
  }

  private async consume(
    stream: AsyncIterable<LlmChunk>,
    read: StreamRead,
  ): Promise<void> {
    for await (const chunk of stream) {
      read.started = true;
      if (chunk.type === 'token') read.answer += chunk.text;
      else read.usage = chunk.usage;
    }
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
