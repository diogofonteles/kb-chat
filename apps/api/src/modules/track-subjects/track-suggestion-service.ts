import { randomUUID } from 'node:crypto';
import {
  TRACK_TITLE_MAX,
  subjectKey,
  type MediaItem,
  type ProposalEstimate,
  type SpendCap,
  type SuggestedSubject,
  type TrackSuggestion,
} from '@kb-chat/contracts';
import { z } from 'zod';
import { startOfAppMonth } from '../../app-calendar.js';
import { AppError } from '../../app-error.js';
import type { LlmMessage, LlmPort, LlmPrice } from '../../ports/llm.js';
import type { MediaSpendLedgerPort } from '../../ports/media-spend-ledger.js';
import type { MediaStorePort } from '../../ports/media-store.js';
import type { SpeakerStorePort } from '../../ports/speaker-store.js';
import type { LinkTarget } from '../../ports/track-subject-store.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import type { MediaActor } from '../media/index.js';
import { tokensOf } from '../spend/index.js';
import { jsonOf } from '../track-proposals/index.js';
import { acceptSubjects, acceptSummary } from './subject-reply.js';
import {
  SUGGESTION_OUTPUT_TOKENS,
  suggestionMessages,
} from './track-suggestion-prompt.js';
import type { TrackSubjectService } from './track-subject-service.js';

const CALL_TIMEOUT_MS = 120_000;
const ROOM = 5;

export interface TrackSuggestionDeps {
  readonly ledger: MediaSpendLedgerPort;
  readonly subjects: Pick<TrackSubjectService, 'collection'>;
  readonly store: Pick<MediaStorePort, 'getMedia'>;
  readonly speakers: Pick<SpeakerStorePort, 'list'>;
  readonly transcripts: Pick<TranscriptStorePort, 'transcripts' | 'segments'>;
  /** The item as this person sees it; throws MEDIA_NOT_FOUND when they cannot. */
  readonly findMedia: (actor: MediaActor, mediaId: string) => MediaItem;
  readonly rootOf: (topic: string) => string;
  readonly llm: () => LlmPort | null;
  readonly caps: { readonly runUsd: number; readonly monthlyUsd: number };
  readonly now?: () => Date;
  readonly onError?: (error: unknown, mediaId: string) => void;
}

/** What is asked: the track and whether subjects are this person's to see. */
export interface SuggestionCall {
  readonly actor: MediaActor;
  readonly mediaId: string;
  readonly classify: boolean;
}

interface StreamUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly usd: number | null;
}

interface StreamRead {
  answer: string;
  usage: StreamUsage | null;
}

interface Plan {
  readonly item: MediaItem;
  readonly topic: string;
  readonly messages: readonly LlmMessage[];
  readonly estimateUsd: number;
  readonly price: LlmPrice;
  readonly llm: LlmPort;
}

const replySchema = z.looseObject({
  titulo: z.unknown().optional(),
  resumo: z.unknown().optional(),
  pergunta: z.unknown().optional(),
  resposta: z.unknown().optional(),
  assuntos: z.array(z.unknown()).catch([]),
  novos: z.array(z.unknown()).catch([]),
});

type Reply = z.infer<typeof replySchema>;

const capError = (cap: SpendCap) =>
  new AppError('MEDIA_SPEND_CAP', `The media ${cap} would be crossed`, {
    details: { cap },
  });

function parseReply(answer: string): Reply | null {
  try {
    const reply = replySchema.safeParse(jsonOf(answer));
    return reply.success ? reply.data : null;
  } catch {
    return null;
  }
}

const titleOf = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const title = value.trim();
  return title && title.length <= TRACK_TITLE_MAX ? title : null;
};

/**
 * "Sugerir de novo com IA" (KBC-073 FR-7): one call, on the media's ledger and caps, that only
 * answers. Nothing is written but what it spent; a person decides each line (BR-9).
 */
export class TrackSuggestionService {
  private readonly now: () => Date;

  constructor(private readonly deps: TrackSuggestionDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async estimate(call: SuggestionCall): Promise<ProposalEstimate> {
    const plan = await this.prepare(call);
    const used = this.deps.ledger.usedSince(startOfAppMonth(this.now()));
    const refusal = this.refusalOf(plan.estimateUsd, used);
    return {
      estimateUsd: plan.estimateUsd,
      runCapUsd: this.deps.caps.runUsd,
      windows: 1,
      model: plan.llm.model,
      allowed: refusal === null,
      refusal,
      restarts: false,
      month: call.actor.isMaster
        ? { spentUsd: used, capUsd: this.deps.caps.monthlyUsd }
        : null,
    };
  }

  async suggest(call: SuggestionCall): Promise<TrackSuggestion> {
    const plan = await this.prepare(call);
    const spendId = this.reserve(call.actor, plan);
    let spentUsd = 0;
    let failed = true;
    try {
      const { answer, usd } = await this.ask(plan);
      spentUsd = usd;
      const reply = parseReply(answer);
      if (!reply)
        throw new AppError(
          'PROVIDER_UNAVAILABLE',
          'The model answered nonsense',
        );
      failed = false;
      return { ...this.toSuggestion(call, plan, reply), spentUsd };
    } catch (err) {
      this.deps.onError?.(err, call.mediaId);
      throw err;
    } finally {
      this.deps.ledger.close({
        id: spendId,
        spentUsd,
        outcome: failed ? 'refunded' : 'settled',
        now: this.now(),
      });
    }
  }

  private async ask(plan: Plan): Promise<{ answer: string; usd: number }> {
    const read: StreamRead = { answer: '', usage: null };
    try {
      await this.consume(plan, read);
    } catch (err) {
      throw new AppError('PROVIDER_UNAVAILABLE', 'The model did not answer', {
        cause: err,
      });
    }
    return { answer: read.answer, usd: costOf(plan, read) };
  }

  private async consume(plan: Plan, read: StreamRead): Promise<void> {
    const stream = plan.llm.stream(plan.messages, {
      maxTokens: SUGGESTION_OUTPUT_TOKENS,
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    for await (const chunk of stream) {
      if (chunk.type === 'token') read.answer += chunk.text;
      else read.usage = chunk.usage;
    }
  }

  private toSuggestion(
    call: SuggestionCall,
    plan: Plan,
    reply: Reply,
  ): Omit<TrackSuggestion, 'spentUsd'> {
    const people = this.peopleOf(plan.topic);
    const speakerOf = (value: unknown) =>
      typeof value === 'string'
        ? (people.get(subjectKey(value)) ?? null)
        : null;
    return {
      title: titleOf(reply.titulo),
      summary: acceptSummary(reply.resumo),
      askerSpeakerId: speakerOf(reply.pergunta),
      answererSpeakerId: speakerOf(reply.resposta),
      subjects: call.classify ? this.subjectsOf(plan, reply) : [],
    };
  }

  private subjectsOf(plan: Plan, reply: Reply): SuggestedSubject[] {
    const { concepts, free } = this.deps.subjects.collection(plan.topic);
    const known = {
      concepts: new Map(concepts.map((name) => [subjectKey(name), name])),
      free: new Map(free.map((one) => [subjectKey(one.name), one.id])),
    };
    const names = new Map(free.map((one) => [one.id, one.name]));
    return acceptSubjects(reply, { known, room: ROOM }).map((target) =>
      toSuggested(target, names),
    );
  }

  private peopleOf(topic: string): ReadonlyMap<string, string> {
    return new Map(
      this.deps.speakers
        .list(this.deps.rootOf(topic))
        .map((one) => [subjectKey(one.name), one.id]),
    );
  }

  private refusalOf(estimateUsd: number, usedUsd: number): SpendCap | null {
    if (estimateUsd > this.deps.caps.runUsd) return 'run-cap';
    if (usedUsd + estimateUsd > this.deps.caps.monthlyUsd) return 'monthly-cap';
    return null;
  }

  private reserve(actor: MediaActor, plan: Plan): string {
    const since = startOfAppMonth(this.now());
    const used = this.deps.ledger.usedSince(since);
    const refusal = this.refusalOf(plan.estimateUsd, used);
    if (refusal) throw capError(refusal);
    const id = randomUUID();
    const reserved = this.deps.ledger.reserve({
      id,
      kind: 'track-suggestion',
      mediaId: plan.item.id,
      principal: actor.principal,
      usd: plan.estimateUsd,
      capUsd: this.deps.caps.monthlyUsd,
      since,
      now: this.now(),
    });
    if (!reserved) throw capError('monthly-cap');
    return id;
  }

  private async prepare(call: SuggestionCall): Promise<Plan> {
    const item = this.deps.findMedia(call.actor, call.mediaId);
    if (!item.parent || item.archived)
      throw new AppError(
        'MEDIA_CONFLICT',
        'Only a live track is suggested for',
        {
          details: { reason: 'not-a-track' },
        },
      );
    const llm = this.deps.llm();
    if (!llm?.configured())
      throw new AppError('LLM_NOT_CONFIGURED', 'The app AI is not connected');
    const price = await priceOf(llm);
    const messages = this.messagesFor(call, item);
    const prompt = messages.map((one) => one.content).join('\n');
    const usd =
      tokensOf(prompt) * price.input + SUGGESTION_OUTPUT_TOKENS * price.output;
    return {
      item,
      topic: item.topic,
      messages,
      price,
      llm,
      estimateUsd: Math.ceil(usd * 1e6) / 1e6,
    };
  }

  private messagesFor(call: SuggestionCall, item: MediaItem): LlmMessage[] {
    const transcript = this.deps.transcripts.transcripts(item.id)[0];
    if (!transcript)
      throw new AppError('MEDIA_NOT_READY', 'This track has no transcript yet');
    const { concepts, free } = this.deps.subjects.collection(item.topic);
    return suggestionMessages({
      recording: item.parent?.title ?? item.title,
      title: item.title,
      text: this.deps.transcripts
        .segments(transcript.id)
        .map((segment) => segment.text.trim())
        .join(' '),
      speakers: this.deps.speakers
        .list(this.deps.rootOf(item.topic))
        .map((one) => one.name),
      subjects: [...concepts, ...free.map((one) => one.name)],
      classify: call.classify,
    });
  }
}

function costOf(plan: Plan, { answer, usage }: StreamRead): number {
  if (usage?.usd != null) return usage.usd;
  const prompt = plan.messages.map((one) => one.content).join('\n');
  const input = usage?.inputTokens ?? tokensOf(prompt);
  const output = usage?.outputTokens ?? tokensOf(answer);
  return input * plan.price.input + output * plan.price.output;
}

async function priceOf(llm: LlmPort): Promise<LlmPrice> {
  try {
    return await llm.price();
  } catch (err) {
    throw new AppError('PROVIDER_UNAVAILABLE', 'The model price is unknown', {
      cause: err,
    });
  }
}

function toSuggested(
  target: LinkTarget,
  names: ReadonlyMap<string, string>,
): SuggestedSubject {
  if (target.kind === 'free')
    return {
      kind: 'free',
      id: target.id,
      name: names.get(target.id) ?? target.id,
    };
  return { kind: target.kind, name: target.name, id: null };
}
