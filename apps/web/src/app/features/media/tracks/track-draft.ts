import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import {
  inTimeOrder,
  type DraftTrack,
  type MediaEdit,
  type TrackProblem,
} from '@kb-chat/contracts';
import { MediaEditApi } from '@core/media/media-edit-api.js';
import {
  EMPTY,
  Subject,
  catchError,
  defer,
  exhaustMap,
  interval,
  map,
  merge,
  of,
  switchMap,
  take,
  tap,
  type Observable,
} from 'rxjs';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { DraftJournal, type KeptDraft } from './track-draft-journal.js';
import {
  EDITABLE,
  blockerOf,
  conflictOf,
  isUncertain,
  problemsOf,
  sameTracks,
  statusOf,
  timingOf,
  toEditTrack,
  type ApproveResult,
  type DraftAction,
  type DraftPhase,
  type ProposeResult,
  type SaveResult,
} from './track-draft-state.js';
import { UndoHistory } from './undo-history.js';

/** A save happens at most this long after the change (BR-6: "até 1 s depois"). */
export const SAVE_DELAY_MS = 800;
/** Without a network, the next try (the `online` event may come first). */
const RETRY_MS = 5_000;
/** "Rascunho salvo" is read aloud at most this often. */
const SPOKEN_EVERY_MS = 10_000;
/** How many unanswered saves the journal holds; past that, a false conflict keeps the copy. */
const SENT_KEPT = 5;

/** Numbered as the screen shows them: by start time. */
export const numbered = (tracks: readonly DraftTrack[]) =>
  inTimeOrder(tracks).map((track, index) => ({ track, ordinal: index + 1 }));

/**
 * The draft on screen (KBC-066 FR-1, FR-7): one state (`DraftPhase`), every change undoable,
 * kept in this browser at once and saved within a second, one save at a time, the newest
 * state winning. What stops a save stops here, with the person's tracks kept to copy (FR-10).
 *
 * Nothing waits to run later: `flush` answers its caller, who decides on the spot, and only
 * a press on this draft approves or starts a paid run (BR-1).
 */
@Injectable()
export class TrackDraft {
  private readonly api = inject(MediaEditApi);
  private readonly journal = inject(DraftJournal);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pollMs = inject(MEDIA_POLL_MS);
  private history = new UndoHistory<readonly DraftTrack[]>();
  private readonly state = signal<DraftPhase>({ kind: 'loading' });
  private readonly shown = signal<readonly DraftTrack[]>([]);
  private readonly server = signal<MediaEdit | null>(null);
  /** Bumps when the tracks or the history move: its getters are not signals. */
  private readonly moves = signal(0);
  private readonly spoken = signal('');
  private readonly wasRestored = signal(false);
  private readonly wasRecovered = signal(false);
  /** Each end of a save: what `flush` answers from. */
  private readonly settled = new Subject<SaveResult>();
  private mediaId = '';
  /** The version the tracks on screen were read or saved at. */
  private version = 0;
  /** Sent with no answer yet, or a lost one: any may be what the server has (I-4, BUG-6). */
  private unanswered: readonly (readonly DraftTrack[])[] = [];
  private kept = false;
  private lastSpoken = 0;

  readonly phase = this.state.asReadonly();
  readonly tracks = this.shown.asReadonly();
  /** The edit as last read: status, step, run, voices. */
  readonly edit = this.server.asReadonly();
  /** What the polite status region reads: "Rascunho salvo", at most every 10 s. */
  readonly announcement = this.spoken.asReadonly();
  /** A saved draft came back from the server: undo started over (BR-6). */
  readonly restored = this.wasRestored.asReadonly();
  /** Changes that had not reached the server came back from this browser. */
  readonly recovered = this.wasRecovered.asReadonly();
  /** Goes on with every change: what depends on "nothing changed since" reads it. */
  readonly revision = this.moves.asReadonly();
  readonly numbered = computed(() => numbered(this.shown()));
  readonly loaded = computed(() => {
    const { kind } = this.state();
    return kind !== 'loading' && kind !== 'unreadable';
  });
  readonly readError = computed(() => {
    const phase = this.state();
    return phase.kind === 'unreadable' ? phase.error : null;
  });
  readonly running = computed(() => this.server()?.run?.status === 'running');
  /** The single answer to "can this be changed now" (I-5). */
  readonly canEdit = computed(() => {
    const phase = this.state();
    const locked = phase.kind === 'saving' && phase.lock !== null;
    return (
      EDITABLE[phase.kind] &&
      !locked &&
      !this.running() &&
      this.server()?.status === 'draft'
    );
  });
  readonly saved = computed(() => {
    const phase = this.state();
    return phase.kind === 'clean' && phase.saved;
  });
  /** A press is running: the buttons wait for its answer. */
  readonly busy = computed(() => this.actionNow() !== null);
  readonly approving = computed(() => this.actionNow() === 'approve');
  readonly canUndo = computed(() => {
    this.moves();
    return this.canEdit() && this.history.canUndo;
  });
  readonly canRedo = computed(() => {
    this.moves();
    return this.canEdit() && this.history.canRedo;
  });

  constructor() {
    const page = inject(DOCUMENT);
    const view = page.defaultView;
    const online = () => this.retryOffline();
    const leaving = () => this.sendBeforeLeaving();
    const hidden = () => {
      if (page.visibilityState === 'hidden') leaving();
    };
    view?.addEventListener('online', online);
    view?.addEventListener('pagehide', leaving);
    // A phone may kill a page in the background without a `pagehide`.
    page.addEventListener('visibilitychange', hidden);
    this.destroyRef.onDestroy(() => {
      view?.removeEventListener('online', online);
      view?.removeEventListener('pagehide', leaving);
      page.removeEventListener('visibilitychange', hidden);
      this.closed();
    });
    this.followRuns();
  }

  /** Reads the draft of a recording, then what this browser still holds of it. */
  open(mediaId: string): void {
    this.mediaId = mediaId;
    this.to({ kind: 'loading' });
    this.read().subscribe({
      next: (edit) => this.load(edit),
      error: (error: unknown) => this.to({ kind: 'unreadable', error }),
    });
  }

  /** The way out of a conflict: what the server has replaces this screen (FR-10). */
  reload(): Observable<MediaEdit> {
    return this.read().pipe(
      tap((edit) => {
        this.journal.forget(this.mediaId);
        this.load(edit);
      }),
    );
  }

  apply(next: readonly DraftTrack[]): void {
    if (!this.canEdit()) return;
    this.history.record(this.shown());
    this.commit(next);
  }

  undo(): void {
    if (!this.canEdit()) return;
    const previous = this.history.undo(this.shown());
    if (previous) this.commit(previous);
  }

  redo(): void {
    if (!this.canEdit()) return;
    const next = this.history.redo(this.shown());
    if (next) this.commit(next);
  }

  /** Marks the edit as started even with nothing changed ("Sair e continuar depois"). */
  touch(): void {
    if (this.canEdit()) this.commit(this.shown());
  }

  /** "Tentar de novo", after a refusal or without a network. */
  retry(): void {
    const { kind } = this.state();
    if (kind === 'failed' || kind === 'offline') this.send();
  }

  /** The changes are safe in this browser even if the server never got them. */
  keptHere(): boolean {
    return this.kept;
  }

  /**
   * Saves what is on screen now and answers once, with how that went; nothing is left behind
   * to run later. `saved` is the only answer that lets an action go on. With a `lock`,
   * nothing can change until the answer, and a press already waiting keeps its lock.
   */
  flush(lock: DraftAction | null = null): Observable<SaveResult> {
    return defer(() => {
      const phase = this.state();
      if (phase.kind === 'clean') return of<SaveResult>('saved');
      if (phase.kind === 'conflict') return of<SaveResult>('conflict');
      if (phase.kind === 'invalid') return of<SaveResult>('invalid');
      if (
        phase.kind === 'loading' ||
        phase.kind === 'unreadable' ||
        phase.kind === 'applying'
      )
        return EMPTY;
      const answer = this.settled.pipe(take(1));
      if (phase.kind === 'saving') {
        this.to({ ...phase, lock: lock ?? phase.lock });
        return answer;
      }
      return merge(
        answer,
        defer(() => this.sendNow(lock)),
      );
    });
  }

  /**
   * The only way to apply (BR-1): after a save of this draft that came back fine. One press
   * at a time: a second one, of this or of `propose`, completes with no answer (BUG-5, F-2).
   */
  approve(): Observable<ApproveResult> {
    return this.unlessBusy('approve').pipe(
      switchMap((result) =>
        result === 'saved'
          ? this.sendApproval()
          : of<ApproveResult>({ kind: 'stopped', result }),
      ),
    );
  }

  /** The only way to a paid run (KBC-067 BR-2): after a save that came back fine. */
  propose(acceptedUsd: number): Observable<ProposeResult> {
    return this.unlessBusy('propose').pipe(
      switchMap((result) =>
        result === 'saved'
          ? this.startRun(acceptedUsd)
          : of<ProposeResult>({ kind: 'stopped', result }),
      ),
    );
  }

  /** Decided at subscription: two presses in one frame come before any button turns off. */
  private unlessBusy(action: DraftAction): Observable<SaveResult> {
    return defer(() => (this.busy() ? EMPTY : this.flush(action)));
  }

  reopen(): Observable<void> {
    return this.api.reopen(this.mediaId, this.version).pipe(
      map(({ version }) => {
        this.version = version;
        this.server.update(
          (edit) =>
            edit && {
              ...edit,
              version,
              status: 'draft' as const,
              step: 3 as const,
            },
        );
      }),
      tap({ finalize: () => this.readFacts() }),
    );
  }

  private actionNow(): DraftAction | null {
    const phase = this.state();
    if (phase.kind === 'saving') return phase.lock;
    return phase.kind === 'applying' ? phase.action : null;
  }

  /** The one way to change state: a timer never outlives the state that set it. */
  private to(next: DraftPhase): void {
    const now = this.state();
    if ('timer' in now && now.timer !== null) clearTimeout(now.timer);
    this.state.set(next);
  }

  private read(): Observable<MediaEdit> {
    return this.api
      .read(this.mediaId)
      .pipe(takeUntilDestroyed(this.destroyRef));
  }

  /** The facts around the draft; without an answer, the screen stays as it is. */
  private readFacts(): void {
    this.read()
      .pipe(catchError(() => EMPTY))
      .subscribe((edit) => this.receive(edit));
  }

  /**
   * While a run writes the draft (KBC-067 FR-3), for whoever has this screen, with
   * `media-edit-ai` or not: a read that fails stops nothing, the next one comes.
   */
  private followRuns(): void {
    const runId = computed(() =>
      this.running() ? (this.server()?.run?.id ?? null) : null,
    );
    toObservable(runId)
      .pipe(
        switchMap((id) =>
          id === null
            ? EMPTY
            : interval(this.pollMs).pipe(
                exhaustMap(() =>
                  this.api.read(this.mediaId).pipe(catchError(() => EMPTY)),
                ),
              ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((edit) => this.receive(edit));
  }

  /** The first read, or a reload: history restarts (BR-6). */
  private load(edit: MediaEdit): void {
    this.server.set(edit);
    this.version = edit.version;
    this.unanswered = [];
    this.show(edit.tracks);
    this.wasRestored.set(edit.started && edit.tracks.length > 0);
    this.wasRecovered.set(false);
    const held = this.journal.read(edit.mediaId);
    if (held && !sameTracks(held.tracks, edit.tracks)) {
      this.resume(held, edit);
      return;
    }
    this.forgetKept();
    this.to({ kind: 'clean', saved: false });
  }

  /** Changes this browser held: they go on, or stay to copy if they no longer fit. */
  private resume(held: KeptDraft, edit: MediaEdit): void {
    this.kept = true;
    this.shown.set(held.tracks);
    this.wasRecovered.set(true);
    this.unanswered = held.sent;
    const blocker = blockerOf(edit) ?? (this.fits(held, edit) ? null : 'stale');
    if (blocker) this.to({ kind: 'conflict', reason: blocker });
    else this.send();
  }

  /** The server is where these changes started, or moved on only by this person's save. */
  private fits(held: KeptDraft, edit: MediaEdit): boolean {
    return (
      held.version === edit.version ||
      held.sent.some((one) => sameTracks(one, edit.tracks))
    );
  }

  /**
   * A later read. It never goes back, and it never replaces a screen with changes or tracks
   * to copy: a proposal's tracks come in only over a clean draft (R-3).
   */
  private receive(edit: MediaEdit): void {
    if (edit.version < (this.server()?.version ?? 0)) return;
    this.server.set(edit);
    if (edit.version === this.version || this.state().kind !== 'clean') return;
    this.version = edit.version;
    this.show(edit.tracks);
  }

  private show(tracks: readonly DraftTrack[]): void {
    this.shown.set(tracks);
    this.history = new UndoHistory();
    this.moves.update((value) => value + 1);
  }

  private commit(tracks: readonly DraftTrack[]): void {
    this.shown.set(tracks);
    this.moves.update((value) => value + 1);
    this.remember();
    const phase = this.state();
    if (phase.kind === 'saving') this.to({ ...phase, changed: true });
    else if (phase.kind === 'invalid' && phase.timing === timingOf(tracks))
      return;
    else if (phase.kind !== 'offline')
      this.to({
        kind: 'pending',
        timer: setTimeout(() => this.send(), SAVE_DELAY_MS),
      });
  }

  private remember(): void {
    this.kept = this.journal.keep(this.mediaId, {
      version: this.version,
      tracks: this.shown(),
      sent: this.unanswered.slice(-SENT_KEPT),
    });
  }

  private forgetKept(): void {
    this.kept = false;
    this.journal.forget(this.mediaId);
  }

  private retryOffline(): void {
    if (this.state().kind === 'offline') this.send();
  }

  /** The page is going (a reload, a closed tab): this write outlives it. */
  private sendBeforeLeaving(): void {
    if (this.state().kind === 'pending') this.send({ keepalive: true });
  }

  /** Left inside the app: BR-6 still holds, and the journal has the rest. */
  private closed(): void {
    const phase = this.state();
    if (phase.kind === 'pending') this.send();
    if (phase.kind === 'offline') this.to({ ...phase, timer: null });
  }

  private sendNow(lock: DraftAction | null): Observable<never> {
    this.send({ lock });
    return EMPTY;
  }

  /**
   * Not bound to the page on purpose (I-10): a save in flight must end even after leaving,
   * and nothing here touches the page, which hears only through `flush`.
   */
  private send(
    options: { lock?: DraftAction | null; keepalive?: boolean } = {},
  ): void {
    const sent = this.shown();
    this.to({ kind: 'saving', changed: false, lock: options.lock ?? null });
    if (!this.unanswered.some((one) => sameTracks(one, sent))) {
      this.unanswered = [...this.unanswered, sent];
    }
    this.remember();
    this.api
      .save(this.mediaId, {
        version: this.version,
        body: { tracks: sent.map(toEditTrack), step: 3 },
        keepalive: options.keepalive,
      })
      .subscribe({
        next: ({ version }) => this.accepted(version),
        error: (err: unknown) => this.refused(err, sent),
      });
  }

  private accepted(version: number): void {
    this.version = version;
    this.unanswered = [];
    this.server.update((edit) => edit && { ...edit, version, started: true });
    this.goOnOrFinish();
  }

  private goOnOrFinish(): void {
    const phase = this.state();
    if (phase.kind === 'saving' && phase.changed) {
      this.send({ lock: phase.lock });
      return;
    }
    this.forgetKept();
    this.to({ kind: 'clean', saved: true });
    this.say();
    this.settled.next('saved');
  }

  private say(): void {
    const now = Date.now();
    if (now - this.lastSpoken < SPOKEN_EVERY_MS) return;
    this.lastSpoken = now;
    this.spoken.set($localize`:@@tracks.saved:Rascunho salvo`);
  }

  private refused(err: unknown, sent: readonly DraftTrack[]): void {
    const status = statusOf(err);
    const problems = problemsOf(err);
    if (isUncertain(status)) this.lost();
    else if (status === 412) this.compare();
    else if (status === 409)
      this.stopAt({ kind: 'conflict', reason: conflictOf(err) }, 'conflict');
    else if (problems.length > 0) this.invalid(problems, timingOf(sent));
    else this.stopAt({ kind: 'failed' }, 'failed');
  }

  /** What moved while that save flew may be the fix: it goes, the rest waits for a change. */
  private invalid(problems: readonly TrackProblem[], timing: string): void {
    const phase = this.state();
    if (
      phase.kind === 'saving' &&
      phase.changed &&
      timingOf(this.shown()) !== timing
    )
      this.send({ lock: phase.lock });
    else this.stopAt({ kind: 'invalid', problems, timing }, 'invalid');
  }

  private lost(): void {
    const timer = this.destroyRef.destroyed
      ? null
      : setTimeout(() => this.send(), RETRY_MS);
    this.stopAt({ kind: 'offline', timer, kept: this.kept }, 'offline');
  }

  /**
   * A 412 may be this person's own save, whose answer was lost: if the server has what was
   * sent, there is nobody else here (I-4). Otherwise it is a conflict (FR-10).
   */
  private compare(): void {
    const conflict = () =>
      this.stopAt({ kind: 'conflict', reason: 'stale' }, 'conflict');
    this.read().subscribe({
      next: (edit) => {
        const mine = this.unanswered.some((one) =>
          sameTracks(one, edit.tracks),
        );
        if (mine) this.adopt(edit);
        else conflict();
      },
      error: conflict,
    });
  }

  private adopt(edit: MediaEdit): void {
    this.version = edit.version;
    this.unanswered = [];
    this.server.set(edit);
    const phase = this.state();
    if (phase.kind !== 'saving') return;
    const changed = !sameTracks(this.shown(), edit.tracks);
    this.to({ ...phase, changed });
    this.goOnOrFinish();
  }

  private stopAt(phase: DraftPhase, result: SaveResult): void {
    this.to(phase);
    this.settled.next(result);
  }

  private sendApproval(): Observable<ApproveResult> {
    this.to({ kind: 'applying', action: 'approve' });
    return this.api.approve(this.mediaId, this.version).pipe(
      map(({ version, tracks }) => {
        this.version = version;
        this.server.update(
          (edit) =>
            edit && {
              ...edit,
              version,
              status: 'approved' as const,
              step: 4 as const,
              approvedTracks: tracks,
            },
        );
        this.to({ kind: 'clean', saved: false });
        this.readFacts();
        return { kind: 'approved' } as const;
      }),
      catchError((err: unknown) => of(this.approvalRefused(err))),
    );
  }

  private approvalRefused(err: unknown): ApproveResult {
    const status = statusOf(err);
    if (status === 412 || status === 409) {
      const reason = status === 412 ? 'stale' : conflictOf(err);
      this.to({ kind: 'conflict', reason });
      return { kind: 'stopped', result: 'conflict' };
    }
    this.to({ kind: 'clean', saved: false });
    if (isUncertain(status)) {
      // The approval may have arrived: the read shows it, and nothing is sent again.
      this.readFacts();
      return { kind: 'stopped', result: 'offline' };
    }
    const problems = problemsOf(err);
    return problems.length > 0
      ? { kind: 'invalid', problems }
      : { kind: 'refused', error: err };
  }

  private startRun(acceptedUsd: number): Observable<ProposeResult> {
    this.to({ kind: 'applying', action: 'propose' });
    return this.api.propose(this.mediaId, acceptedUsd).pipe(
      map((run) => {
        this.server.update(
          (edit) => edit && { ...edit, run, lastFailure: null, stopped: null },
        );
        this.to({ kind: 'clean', saved: false });
        return { kind: 'started' } as const;
      }),
      catchError((error: unknown) => {
        this.to({ kind: 'clean', saved: false });
        this.readFacts();
        return of<ProposeResult>({ kind: 'refused', error });
      }),
    );
  }
}
