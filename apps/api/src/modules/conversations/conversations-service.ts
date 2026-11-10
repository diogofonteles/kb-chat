import {
  RESEARCH_TURN_MAX_MINUTES,
  summarizeConversation,
  type Conversation,
  type ConversationKind,
  type ConversationSummary,
  type ResearchConversation,
  type SavedResearchTurn,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { ConversationStorePort } from '../../ports/conversation-store.js';
import type { LevelView } from '../../ports/level-view.js';
import { maskConversation, type ScopeOf } from './conversation-mask.js';
import {
  mergeResearchTurns,
  unmaskResearchTurns,
  settleDeadTurns,
  withTurn,
  type Liveness,
} from './research-turns.js';

export interface ConversationFilter {
  readonly kind?: ConversationKind;
  readonly topic?: string;
}

/** Today's view of a collection for the reader (KBC-110): how a stored answer is re-checked. */
export type ViewOf = (topic: string) => LevelView;

export interface ConversationsServiceDeps {
  readonly store: ConversationStorePort;
  /** The catalog's collection and sub-collections, to judge a stored source (KBC-110). */
  readonly scopeOf?: ScopeOf;
  /** Whether the person's research turn runs in this process (KBC-029); none by default. */
  readonly isLive?: (principal: string, turnId: string) => boolean;
  /** When this process started (ms); default: when the service was built. */
  readonly bootAt?: number;
  readonly now?: () => number;
  /** A pending turn older than this reads as interrupted; default 60 min (the turn ceiling). */
  readonly ceilingMs?: number;
}

/** Where the server records a research turn (KBC-029). */
export interface TurnPlace {
  readonly conversationId: string;
  /** The collection of the request: a conversation of another one is refused. */
  readonly topic: string;
  readonly turn: SavedResearchTurn;
}

const matches = (summary: ConversationSummary, filter: ConversationFilter) =>
  (filter.kind === undefined || summary.kind === filter.kind) &&
  (filter.topic === undefined || summary.topic === filter.topic);

/** Newest first; equal timestamps keep a stable order by id. */
const byNewest = (a: ConversationSummary, b: ConversationSummary) =>
  b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);

/**
 * The complete conversation history kept on this computer (no cap), per principal: each
 * person only lists, reads and removes their own (KBC-010 BR-6).
 */
export class ConversationsService {
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly bootAt: number;

  constructor(private readonly deps: ConversationsServiceDeps) {
    this.bootAt = deps.bootAt ?? Date.now();
  }

  async list(
    principal: string,
    filter: ConversationFilter = {},
  ): Promise<ConversationSummary[]> {
    const all = await this.deps.store.list(principal);
    const liveness = this.liveness(principal);
    return all
      .map((c) => summarizeConversation(settleDeadTurns(c, liveness)))
      .filter((summary) => matches(summary, filter))
      .sort(byNewest);
  }

  /**
   * The conversation as the reader may see it today (KBC-110, ADR 0036 §8): sources above
   * their level, or of a collection they lost, come back restricted; the file is untouched.
   */
  async get(
    principal: string,
    id: string,
    viewOf: ViewOf,
  ): Promise<Conversation | null> {
    const conversation = await this.deps.store.get(principal, id);
    if (!conversation) return null;
    const settled = settleDeadTurns(conversation, this.liveness(principal));
    return maskConversation(
      settled,
      viewOf(settled.topic),
      this.deps.scopeOf ?? (() => undefined),
    );
  }

  /** A page's snapshot; research turns merge by id with what the server recorded (KBC-029). */
  save(
    principal: string,
    conversation: Conversation,
  ): Promise<ConversationSummary> {
    return this.serial(conversation.id, async () => {
      const stored =
        conversation.kind === 'research'
          ? await this.deps.store.get(principal, conversation.id)
          : null;
      // A snapshot read masked keeps what the file had (KBC-110 BR-4).
      const merged =
        conversation.kind === 'research'
          ? mergeResearchTurns(
              unmaskResearchTurns(conversation, stored),
              stored,
            )
          : conversation;
      await this.put(principal, merged);
      return summarizeConversation(merged);
    });
  }

  /**
   * Records a research turn as it starts (KBC-029): a new conversation takes the question as
   * its title; a turn with the same id (a retry) is replaced.
   */
  beginTurn(principal: string, place: TurnPlace): Promise<void> {
    return this.serial(place.conversationId, async () => {
      const stored = await this.deps.store.get(principal, place.conversationId);
      if (
        stored &&
        (stored.kind !== 'research' || stored.topic !== place.topic)
      )
        throw new AppError(
          'VALIDATION_FAILED',
          'Not a research conversation of this collection',
        );
      const at = this.stamp();
      const conversation: ResearchConversation = stored
        ? { ...stored, updatedAt: at, turns: withTurn(stored, place.turn) }
        : this.started(place, at);
      await this.put(principal, conversation);
    });
  }

  /** Records how a turn ended; a conversation removed meanwhile stays removed. */
  finishTurn(
    principal: string,
    conversationId: string,
    turn: SavedResearchTurn,
  ): Promise<void> {
    return this.serial(conversationId, async () => {
      const stored = await this.deps.store.get(principal, conversationId);
      if (stored?.kind !== 'research') return;
      const turns = withTurn(stored, turn);
      await this.put(principal, { ...stored, updatedAt: this.stamp(), turns });
    });
  }

  remove(principal: string, id: string): Promise<boolean> {
    return this.deps.store.remove(principal, id);
  }

  private started(place: TurnPlace, at: string): ResearchConversation {
    return {
      kind: 'research',
      id: place.conversationId,
      topic: place.topic,
      title: place.turn.question,
      createdAt: at,
      updatedAt: at,
      turns: [place.turn],
    };
  }

  private async put(principal: string, conversation: Conversation) {
    // Another person's id is answered like an unknown one (KBC-010 BR-6).
    if (!(await this.deps.store.put(principal, conversation)))
      throw new AppError('NOT_FOUND', 'Unknown conversation');
  }

  /** One read-modify-write at a time per conversation (the page and the server both write). */
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(work);
    const settled = next.catch(() => undefined);
    this.locks.set(id, settled);
    void settled.then(() => {
      if (this.locks.get(id) === settled) this.locks.delete(id);
    });
    return next;
  }

  private liveness(principal: string): Liveness {
    const isLive = this.deps.isLive ?? (() => false);
    return {
      isLive: (turnId) => isLive(principal, turnId),
      bootAt: this.bootAt,
      now: this.now(),
      ceilingMs: this.deps.ceilingMs ?? RESEARCH_TURN_MAX_MINUTES * 60_000,
    };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private stamp(): string {
    return new Date(this.now()).toISOString();
  }
}
