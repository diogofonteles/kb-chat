import { DOCUMENT } from '@angular/common';
import {
  Injectable,
  InjectionToken,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { MediaEngine, type PlayableSource } from './media-engine.js';

/** The part of `navigator.mediaSession` the player uses. */
export interface SessionLike {
  metadata: MediaMetadata | MediaMetadataInit | null;
  playbackState: MediaSessionPlaybackState;
  setActionHandler(
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null,
  ): void;
  setPositionState(state?: MediaPositionState): void;
}

/** The browser's Media Session, or null where there is none. */
export const MEDIA_SESSION = new InjectionToken<SessionLike | null>(
  'MEDIA_SESSION',
  {
    providedIn: 'root',
    factory: () => inject(DOCUMENT).defaultView?.navigator.mediaSession ?? null,
  },
);

const SKIP_BACK_S = 15;
const SKIP_FORWARD_S = 30;
const ICON_SIZES = [96, 128, 192, 256, 384, 512];
const ACTIONS: readonly MediaSessionAction[] = [
  'play',
  'pause',
  'seekbackward',
  'seekforward',
  'seekto',
  'stop',
];

/**
 * The lock screen, the control center and the headphones' buttons (KBC-041 FR-7): what
 * plays, its controls and its position, kept in step with the media engine and cleared
 * when the player closes.
 */
@Injectable({ providedIn: 'root' })
export class MediaSessionAdapter {
  private readonly engine = inject(MediaEngine);
  private readonly session = inject(MEDIA_SESSION);
  /** What the position state depends on: not every time update, only real changes. */
  private readonly positionInputs = computed(
    () => {
      const { durationMs, phase } = this.engine.playback();
      return {
        durationMs,
        phase,
        seeks: this.engine.seeksLanded(),
        speed: this.engine.speed(),
      };
    },
    {
      equal: (a, b) =>
        a.durationMs === b.durationMs &&
        a.phase === b.phase &&
        a.seeks === b.seeks &&
        a.speed === b.speed,
    },
  );

  constructor() {
    const session = this.session;
    if (!session) return;
    effect(() => {
      const source = this.engine.source();
      untracked(() =>
        source ? this.open(session, source) : this.close(session),
      );
    });
    effect(() => {
      const playing = this.engine.playing();
      const loaded = this.engine.source() !== null;
      session.playbackState = playing ? 'playing' : loaded ? 'paused' : 'none';
    });
    effect(() => {
      const { durationMs, speed } = this.positionInputs();
      if (!durationMs || durationMs <= 0) return;
      const currentMs = untracked(() => this.engine.playback().currentMs);
      session.setPositionState({
        duration: durationMs / 1000,
        playbackRate: speed,
        position: Math.min(currentMs, durationMs) / 1000,
      });
    });
  }

  private open(session: SessionLike, source: PlayableSource): void {
    const init: MediaMetadataInit = {
      title: source.title,
      artist: source.artist
        ? `${source.artist} — Nova Alexandria`
        : 'Nova Alexandria',
      artwork: ICON_SIZES.map((size) => ({
        src: `/icons/icon-${size}.png`,
        sizes: `${size}x${size}`,
        type: 'image/png',
      })),
    };
    session.metadata =
      typeof MediaMetadata === 'function' ? new MediaMetadata(init) : init;
    const engine = this.engine;
    const handlers: Record<string, MediaSessionActionHandler> = {
      play: () => engine.play(),
      pause: () => engine.pause(),
      stop: () => engine.pause(),
      seekbackward: (details) =>
        engine.skip(-(details.seekOffset ?? SKIP_BACK_S) * 1000),
      seekforward: (details) =>
        engine.skip((details.seekOffset ?? SKIP_FORWARD_S) * 1000),
      seekto: (details) => {
        if (details.seekTime !== undefined)
          engine.seek(details.seekTime * 1000, details.fastSeek === true);
      },
    };
    for (const action of ACTIONS)
      this.setHandler(session, action, handlers[action] ?? null);
  }

  private close(session: SessionLike): void {
    session.metadata = null;
    for (const action of ACTIONS) this.setHandler(session, action, null);
  }

  /** Browsers throw on an action they do not know: that one is simply not offered. */
  private setHandler(
    session: SessionLike,
    action: MediaSessionAction,
    handler: MediaSessionActionHandler | null,
  ): void {
    try {
      session.setActionHandler(action, handler);
    } catch {
      // Not supported here.
    }
  }
}
