import { HttpErrorResponse } from '@angular/common/http';
import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  approvalProblems,
  inTimeOrder,
  type DraftTrack,
  type MediaEdit,
  type TrackProblem,
} from '@kb-chat/contracts';
import { apiErrorSchema } from '@kb-chat/contracts';
import { MediaEditApi } from '@core/media/media-edit-api.js';
import { UndoHistory } from './undo-history.js';

/** A save happens at most this long after the change (BR-6: "até 1 s depois"). */
export const SAVE_DELAY_MS = 800;
/** Without a network, the next try (the `online` event may come first). */
const RETRY_MS = 5_000;
/** "Rascunho salvo" is read aloud at most this often. */
const SPOKEN_EVERY_MS = 10_000;

export type SaveState = 'idle' | 'saving' | 'saved' | 'offline' | 'conflict' | 'failed';

/** Numbered as the screen shows them: by start time. */
export const numbered = (tracks: readonly DraftTrack[]) =>
  inTimeOrder(tracks).map((track, index) => ({ track, ordinal: index + 1 }));

const toEditTrack = (track: DraftTrack) => ({
  id: track.id,
  source: track.source,
  startMs: track.startMs,
  endMs: track.endMs,
  kind: track.kind,
  title: track.title,
  askerVoice: track.askerVoice,
  answererVoice: track.answererVoice,
  askerSpeakerId: track.askerSpeakerId,
  answererSpeakerId: track.answererSpeakerId,
});

const statusOf = (err: unknown): number =>
  err instanceof HttpErrorResponse ? err.status : -1;

/** The answer's own code, for what a status alone does not say. */
export function problemsOf(err: unknown): readonly TrackProblem[] {
  if (!(err instanceof HttpErrorResponse)) return [];
  const parsed = apiErrorSchema.safeParse(err.error);
  const details = parsed.success ? parsed.data.error.details : null;
  if (typeof details !== 'object' || details === null) return [];
  return (details as { problems?: readonly TrackProblem[] }).problems ?? [];
}

/**
 * The draft on screen (KBC-066 FR-1, FR-7): every change is undoable and saved within a
 * second, one save at a time, the newest state winning. Without a network the changes wait;
 * a save someone else got ahead of stops here, with the person's tracks kept to copy (FR-10).
 */
@Injectable()
export class TrackDraft {
  private readonly api = inject(MediaEditApi);
  private readonly history = new UndoHistory<readonly DraftTrack[]>();
  private readonly state = signal<readonly DraftTrack[]>([]);
  private readonly saveState = signal<SaveState>('idle');
  private readonly durationValue = signal<number | null>(null);
  /** Bumps when the history moves: its getters are not signals. */
  private readonly moves = signal(0);
  private readonly spoken = signal('');
  private mediaId = '';
  private version = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  private inFlight = false;
  private lastSpoken = 0;
  private waiting: (() => void)[] = [];

  readonly tracks = this.state.asReadonly();
  readonly save = this.saveState.asReadonly();
  /** What the polite status region reads: "Rascunho salvo", at most every 10 s. */
  readonly announcement = this.spoken.asReadonly();
  readonly numbered = computed(() => numbered(this.state()));
  readonly problems = computed<readonly TrackProblem[]>(() =>
    approvalProblems(this.state(), this.durationValue()),
  );
  readonly canUndo = computed(() => {
    this.moves();
    return this.history.canUndo;
  });
  readonly canRedo = computed(() => {
    this.moves();
    return this.history.canRedo;
  });

  constructor() {
    const online = () => this.retry();
    addEventListener('online', online);
    inject(DestroyRef).onDestroy(() => {
      removeEventListener('online', online);
      if (this.timer !== null) clearTimeout(this.timer);
    });
  }

  /** The draft as read from the server: history restarts (BR-6). */
  load(edit: MediaEdit, durationMs: number | null): void {
    this.mediaId = edit.mediaId;
    this.version = edit.version;
    this.durationValue.set(durationMs);
    this.state.set(edit.tracks);
  }

  /** A proposal grew the draft (KBC-067): the same draft, one version on. */
  refresh(edit: MediaEdit): void {
    this.version = edit.version;
    this.state.set(edit.tracks);
    this.moves.update((value) => value + 1);
  }

  get currentVersion(): number {
    return this.version;
  }

  apply(next: readonly DraftTrack[]): void {
    this.history.record(this.state());
    this.moves.update((value) => value + 1);
    this.commit(next);
  }

  undo(): void {
    const previous = this.history.undo(this.state());
    if (previous) this.moved(previous);
  }

  redo(): void {
    const next = this.history.redo(this.state());
    if (next) this.moved(next);
  }

  private moved(tracks: readonly DraftTrack[]): void {
    this.moves.update((value) => value + 1);
    this.commit(tracks);
  }

  private commit(tracks: readonly DraftTrack[]): void {
    this.state.set(tracks);
    this.dirty = true;
    this.schedule(SAVE_DELAY_MS);
  }

  private schedule(delayMs: number): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.send(), delayMs);
  }

  private retry(): void {
    if (this.dirty && this.saveState() === 'offline') this.send();
  }

  /** Saves what is on screen now; `done` runs once nothing is left to save. */
  flush(done: () => void): void {
    this.waiting.push(done);
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (this.dirty) this.send();
    else if (!this.inFlight) this.settled();
  }

  /** Marks the edit as started even with nothing changed ("Sair e continuar depois"). */
  touch(): void {
    this.dirty = true;
  }

  private settled(): void {
    const waiting = this.waiting;
    this.waiting = [];
    for (const done of waiting) done();
  }

  private send(): void {
    if (this.inFlight || !this.dirty) return;
    if (this.saveState() === 'conflict') return;
    const sent = this.state();
    this.inFlight = true;
    this.dirty = false;
    this.saveState.set('saving');
    this.api
      .save(this.mediaId, {
        version: this.version,
        body: { tracks: sent.map(toEditTrack), step: 3 },
      })
      .subscribe({
        next: ({ version }) => this.saved(version),
        error: (err: unknown) => this.refused(err),
      });
  }

  private saved(version: number): void {
    this.version = version;
    this.inFlight = false;
    if (this.dirty) {
      this.send();
      return;
    }
    this.saveState.set('saved');
    this.say();
    this.settled();
  }

  private say(): void {
    const now = Date.now();
    if (now - this.lastSpoken < SPOKEN_EVERY_MS) return;
    this.lastSpoken = now;
    this.spoken.set($localize`:@@tracks.saved:Rascunho salvo`);
  }

  private refused(err: unknown): void {
    this.inFlight = false;
    this.dirty = true;
    const status = statusOf(err);
    if (status === 412) this.saveState.set('conflict');
    else if (status === 0 || status === 502 || status === 504) {
      this.saveState.set('offline');
      this.schedule(RETRY_MS);
    } else this.saveState.set('failed');
    if (status !== 0) this.settled();
  }
}
