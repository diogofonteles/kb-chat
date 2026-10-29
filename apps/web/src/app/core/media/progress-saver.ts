import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { ListeningApi } from './listening-api.js';
import { MediaEngine, type PlayableSource } from './media-engine.js';

/** The browser keeps the position this often while playing (FR-3). */
const KEEP_EVERY_MS = 1_000;
/** The account receives it this often while playing (FR-3, NFR-2). */
const SEND_EVERY_MS = 10_000;

const storageKey = (id: string): string => `kb-chat.media-position.${id}`;

/**
 * Where the person is, kept as they listen (KBC-041 FR-3): in the browser every second,
 * on the account every 10 s while playing, at once on a pause, on a change of media, when
 * the tab is hidden and as the page goes away (a request that outlives it). A position
 * the server already has is never sent again; one that failed is sent at the next chance.
 */
@Injectable({ providedIn: 'root' })
export class ProgressSaver {
  private readonly engine = inject(MediaEngine);
  private readonly api = inject(ListeningApi);
  private readonly document = inject(DOCUMENT);
  /** The last position the server confirmed, per media. */
  private readonly confirmed = new Map<string, number>();
  /** The position on its way to the server, per media: not sent a second time. */
  private readonly sending = new Map<string, number>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private lastSentAt = 0;
  private followed: PlayableSource | null = null;
  private wasPlaying = false;

  constructor() {
    effect(() => {
      const source = this.engine.source();
      const playing = this.engine.playing();
      untracked(() => this.follow(source, playing));
    });
    const hidden = () => {
      if (this.document.visibilityState === 'hidden') this.sendBeforeLeaving();
    };
    const leaving = () => this.sendBeforeLeaving();
    const view = this.document.defaultView;
    this.document.addEventListener('visibilitychange', hidden);
    view?.addEventListener('pagehide', leaving);
    inject(DestroyRef).onDestroy(() => {
      this.stopTicker();
      this.document.removeEventListener('visibilitychange', hidden);
      view?.removeEventListener('pagehide', leaving);
    });
  }

  /** A position kept in this browser and not yet confirmed by the server; else null. */
  localPosition(id: string): number | null {
    try {
      const kept = localStorage.getItem(storageKey(id));
      return kept === null ? null : Number(kept);
    } catch {
      return null;
    }
  }

  /** Keeps and sends the position now ("Fechar o player", before the media goes). */
  saveNow(): void {
    const source = this.followed;
    if (!source) return;
    this.keep();
    this.send(source.id);
  }

  /** Sends a position this browser kept and the server never confirmed (FR-3). */
  resend(id: string): void {
    this.send(id);
  }

  private follow(source: PlayableSource | null, playing: boolean): void {
    const previous = this.followed;
    if (previous && previous.id !== source?.id) {
      // Another media (or none): the one left keeps its last position.
      this.stopTicker();
      this.wasPlaying = false;
      this.send(previous.id);
    }
    this.followed = source;
    if (playing && !this.ticker) {
      this.lastSentAt = Date.now();
      this.ticker = setInterval(() => this.tick(), KEEP_EVERY_MS);
    } else if (!playing && this.ticker) {
      this.stopTicker();
    }
    if (!playing && this.wasPlaying && source) {
      this.keep();
      this.send(source.id);
    }
    this.wasPlaying = playing;
  }

  private tick(): void {
    const source = this.followed;
    if (!source) return;
    this.keep();
    if (Date.now() - this.lastSentAt < SEND_EVERY_MS) return;
    this.lastSentAt = Date.now();
    this.send(source.id);
  }

  /** The current position, in this browser, never past the end the server knows. */
  private keep(): void {
    const source = this.followed;
    if (!source) return;
    const { currentMs } = this.engine.playback();
    const end = source.durationMs ?? Number.POSITIVE_INFINITY;
    const position = Math.floor(Math.min(currentMs, end));
    try {
      localStorage.setItem(storageKey(source.id), String(position));
    } catch {
      // Private mode or a full storage: the account still gets the position.
    }
  }

  private send(id: string): void {
    const position = this.localPosition(id);
    if (position === null || this.known(id, position)) return;
    this.sending.set(id, position);
    this.api.saveProgress(id, position).subscribe({
      next: () => {
        this.sending.delete(id);
        this.confirm(id, position);
      },
      // Kept in the browser: the next chance sends it again.
      error: () => this.sending.delete(id),
    });
  }

  /** The server has this position, or it is on its way there. */
  private known(id: string, position: number): boolean {
    return (
      this.confirmed.get(id) === position || this.sending.get(id) === position
    );
  }

  private confirm(id: string, position: number): void {
    this.confirmed.set(id, position);
    if (this.localPosition(id) !== position) return;
    try {
      localStorage.removeItem(storageKey(id));
    } catch {
      // Nothing kept: nothing to forget.
    }
  }

  private sendBeforeLeaving(): void {
    const source = this.followed;
    if (!source) return;
    this.keep();
    const position = this.localPosition(source.id);
    if (position === null || this.known(source.id, position)) return;
    this.api.saveProgressOnExit(source.id, position);
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
  }
}
