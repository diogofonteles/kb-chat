import { setTimeout as sleep } from 'node:timers/promises';
import {
  RESEARCH_TURN_MAX_MINUTES,
  type ResearchEvent,
} from '@kb-chat/contracts';

/** Past it, a recorded turn is stopped (and a pending one reads as interrupted). */
export const TURN_CEILING_MS = RESEARCH_TURN_MAX_MINUTES * 60_000;

/** Who follows a turn's events: the page that asked, or one that came back (KBC-029). */
export interface TurnFollower {
  event(event: ResearchEvent): void;
  end(): void;
}

export interface LiveTurnKey {
  readonly principal: string;
  readonly conversationId: string;
  readonly turnId: string;
}

/**
 * One recorded research turn while it runs, apart from any connection: it keeps its events
 * so a page that reloads can follow it from the start.
 */
export class LiveTurn {
  readonly abort = new AbortController();
  readonly events: ResearchEvent[] = [];
  private readonly followers = new Set<TurnFollower>();
  private ended = false;

  constructor(readonly key: LiveTurnKey) {}

  publish(event: ResearchEvent): void {
    this.events.push(event);
    for (const follower of this.followers) follower.event(event);
  }

  /** Replays what happened so far, then live; returns the way to stop following. */
  follow(follower: TurnFollower): () => void {
    for (const event of this.events) follower.event(event);
    if (this.ended) {
      follower.end();
      return () => undefined;
    }
    this.followers.add(follower);
    return () => this.followers.delete(follower);
  }

  finish(): void {
    this.ended = true;
    for (const follower of this.followers) follower.end();
    this.followers.clear();
  }
}

/** Turns are kept per person: another person's id never reaches them (BR-4). */
const slotOf = (principal: string, turnId: string): string =>
  JSON.stringify([principal, turnId]);

/** One turn at a time per conversation (or turn id), and only ever the person's own. */
const isSameSlot = (a: LiveTurnKey, b: LiveTurnKey): boolean =>
  a.principal === b.principal &&
  (a.conversationId === b.conversationId || a.turnId === b.turnId);

export interface LiveTurnsOptions {
  readonly ceilingMs?: number;
}

/**
 * The recorded research turns running in this process (KBC-029), by turn id. A turn ends
 * when its agent does, is stopped only by "Parar" (or the ceiling), and one conversation runs
 * one turn at a time. In memory: a restart loses them, and the history then reads their
 * pending turns as interrupted.
 */
export class LiveTurns {
  private readonly turns = new Map<string, LiveTurn>();
  private readonly timers = new Map<LiveTurn, ReturnType<typeof setTimeout>>();
  private readonly runs = new Set<Promise<unknown>>();
  private readonly ceilingMs: number;

  constructor(options: LiveTurnsOptions = {}) {
    this.ceilingMs = options.ceilingMs ?? TURN_CEILING_MS;
  }

  /** Registers a turn, stopping the person's turn still running in its conversation. */
  start(key: LiveTurnKey): LiveTurn {
    for (const other of this.turns.values())
      if (isSameSlot(other.key, key)) other.abort.abort();
    const turn = new LiveTurn(key);
    this.turns.set(slotOf(key.principal, key.turnId), turn);
    const timer = setTimeout(() => turn.abort.abort(), this.ceilingMs);
    timer.unref();
    this.timers.set(turn, timer);
    return turn;
  }

  /** The turn's agent is done and its outcome saved: followers get the end. */
  end(turn: LiveTurn): void {
    clearTimeout(this.timers.get(turn));
    this.timers.delete(turn);
    const slot = slotOf(turn.key.principal, turn.key.turnId);
    if (this.turns.get(slot) === turn) this.turns.delete(slot);
    turn.finish();
  }

  /** The person's running turn with that id; another person's is never found. */
  find(principal: string, turnId: string): LiveTurn | null {
    return this.turns.get(slotOf(principal, turnId)) ?? null;
  }

  isLive(principal: string, turnId: string): boolean {
    return this.find(principal, turnId) !== null;
  }

  /** "Parar": false when no such turn runs for that person. */
  stop(principal: string, turnId: string): boolean {
    const turn = this.find(principal, turnId);
    turn?.abort.abort();
    return turn !== null;
  }

  /** Keeps the promise of a running turn, so closing can wait for it to be saved. */
  track(run: Promise<unknown>): void {
    this.runs.add(run);
    // A run settles its own errors; this only forgets it.
    run.finally(() => this.runs.delete(run)).catch(() => undefined);
  }

  /** Shutdown: stops every turn and waits (up to `graceMs`) for them to be saved. */
  async close(graceMs: number): Promise<void> {
    for (const turn of this.turns.values()) turn.abort.abort();
    await Promise.race([
      Promise.allSettled([...this.runs]),
      sleep(graceMs, undefined, { ref: false }),
    ]);
  }
}
