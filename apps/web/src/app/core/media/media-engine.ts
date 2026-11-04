import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  isDevMode,
  signal,
} from '@angular/core';
import {
  INITIAL_PLAYBACK,
  canAskToPlay,
  clampToDuration,
  errorKindOf,
  isBusy,
  isOperable,
  reducePlayback,
  DEFAULT_SPEED,
  type PlaybackErrorKind,
  type PlaybackEvent,
  type PlaybackSpeed,
  type PlaybackState,
} from '@kb-chat/player-core';

/** What the engine plays: a media item of the library and its stream URL. */
export interface PlayableSource {
  readonly id: string;
  readonly title: string;
  readonly src: string;
  /** The length the server knows: positions saved to it never pass it (KBC-041 FR-2). */
  readonly durationMs?: number | null;
  /** Who is speaking, for the system's media controls (KBC-041 FR-7). */
  readonly artist?: string;
  /** A track's cut: positions read on it name it, so an older one is translated (KBC-073). */
  readonly fileVersion?: number;
}

/**
 * The media element the engine drives. In the app it is one hidden `<audio>` in the page
 * (in the document, so the browser keeps it alive and tools can find it); video (KBC-035)
 * passes a `<video>`. Tests give a real element whose playback methods are faked.
 */
export const MEDIA_ELEMENT_FACTORY = new InjectionToken<() => HTMLMediaElement>(
  'MEDIA_ELEMENT_FACTORY',
  {
    providedIn: 'root',
    factory: () => {
      const document = inject(DOCUMENT);
      return () => createMediaElement(document, mediaTagOf(document));
    },
  },
);

/**
 * The tag the engine uses: `<audio>`; in development only, `?mediaElement=video` gives a
 * `<video>`, so the E2E proves the same engine on a real video element (ADR 0025, AC-14).
 * A production build ignores the parameter.
 */
export function mediaTagOf(document: Document): 'audio' | 'video' {
  const asked = new URLSearchParams(document.location.search).get(
    'mediaElement',
  );
  return isDevMode() && asked === 'video' ? 'video' : 'audio';
}

function createMediaElement(
  document: Document,
  tag: 'audio' | 'video',
): HTMLMediaElement {
  const element = document.createElement(tag);
  element.hidden = true;
  element.dataset['mediaEngine'] = '';
  if (element instanceof HTMLVideoElement) element.playsInline = true;
  document.body.append(element);
  return element;
}

/** How close to the end a paused seek counts as the end (browsers stop a few ms short). */
const END_TOLERANCE_MS = 50;

/** Waiting shorter than this is not shown (no flicker on each network pause). */
export const BUFFERING_DEBOUNCE_MS = 300;

/**
 * Waiting this long means the connection is gone: browsers keep waiting forever without an
 * error, so the engine stops and reports a network error the person can retry (AC-12).
 */
export const MEDIA_STALL_TIMEOUT_MS = new InjectionToken<number>(
  'MEDIA_STALL_TIMEOUT_MS',
  {
    providedIn: 'root',
    factory: () => 12_000,
  },
);

type MediaEventName = keyof HTMLMediaElementEventMap;

/**
 * The app's single media engine (ADR 0025): one media element for the whole app, so only
 * one thing plays at a time and playback survives navigation (the mini-player, KBC-041).
 * Its state is derived only from what the element reports (`@kb-chat/player-core`).
 */
@Injectable({ providedIn: 'root' })
export class MediaEngine {
  private readonly createElement = inject(MEDIA_ELEMENT_FACTORY);
  private readonly stallTimeoutMs = inject(MEDIA_STALL_TIMEOUT_MS);
  private stallTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly state = signal<PlaybackState>(INITIAL_PLAYBACK);
  private readonly current = signal<PlayableSource | null>(null);
  private element: HTMLMediaElement | null = null;
  private bufferingTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingStartMs: number | null = null;
  /**
   * A seek the app makes on its own (the start position of a load, a skipped silence):
   * not the person's, so it is neither announced nor counted (FR-3, FR-10).
   */
  private ownSeek = false;
  private loads = 0;
  private readonly speedValue = signal<PlaybackSpeed>(DEFAULT_SPEED);
  private readonly volumeValue = signal(1);
  private readonly mutedValue = signal(false);
  private readonly landedSeeks = signal(0);
  private readonly askedSeeks = signal(0);
  private readonly playedSinceLoad = signal(false);

  readonly playback = this.state.asReadonly();
  readonly source = this.current.asReadonly();
  readonly playing = computed(() => this.state().phase === 'playing');
  readonly operable = computed(() => isOperable(this.state()));
  /** "Tocar" may be pressed (also while the source loads: the tap starts it on iPhone). */
  readonly canPlay = computed(() => canAskToPlay(this.state()));
  /** Show the busy indicator: a requested play still loading, or a long wait. */
  readonly busy = computed(() => isBusy(this.state()));
  /** The speed every source plays at (KBC-041 FR-5). */
  readonly speed = this.speedValue.asReadonly();
  readonly volume = this.volumeValue.asReadonly();
  readonly muted = this.mutedValue.asReadonly();
  /** Counts the seeks the person asked for that landed (announcements, KBC-041 FR-10). */
  readonly seeksLanded = this.landedSeeks.asReadonly();
  /** Counts the seeks asked for, the moment they are asked: a later one replaces a plan. */
  readonly seeksAsked = this.askedSeeks.asReadonly();
  /** The current source played at least once since it was loaded. */
  readonly hasPlayed = this.playedSinceLoad.asReadonly();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.unload());
  }

  /** Loads a source (paused, never autoplay: KBC-041 BR-3); `startAtMs` seeks once ready. */
  load(source: PlayableSource, startAtMs = 0): void {
    const element = this.ensureElement();
    this.clearBuffering();
    this.loads++;
    this.current.set(source);
    this.playedSinceLoad.set(false);
    this.pendingStartMs = startAtMs > 0 ? startAtMs : null;
    this.dispatch({ type: 'load', loadId: this.loads });
    element.preload = 'metadata';
    element.src = source.src;
    element.load();
    // Loading puts the rate back to the default (HTML's load algorithm): set it again.
    this.applySpeed(element);
  }

  /** The loaded media got a new title (KBC-050): the sound goes on, the labels follow. */
  retitle(id: string, title: string): void {
    this.current.update((source) =>
      source?.id === id ? { ...source, title } : source,
    );
  }

  /** Plays this and every later source at `speed`, keeping the voice's pitch. */
  setSpeed(speed: PlaybackSpeed): void {
    this.speedValue.set(speed);
    if (this.element) this.applySpeed(this.element);
  }

  /** Sets the volume (0–1); raising it from silence unmutes (FR-9). */
  setVolume(volume: number): void {
    const element = this.ensureElement();
    element.volume = Math.min(1, Math.max(0, volume));
    if (element.volume > 0) element.muted = false;
    this.syncVolume(element);
  }

  /**
   * Sets the volume (0–1) for a fade the app runs (the sleep timer): the person's mute
   * stays as it is, whatever the volume.
   */
  fadeVolume(volume: number): void {
    const element = this.ensureElement();
    element.volume = Math.min(1, Math.max(0, volume));
    this.syncVolume(element);
  }

  toggleMute(): void {
    const element = this.ensureElement();
    element.muted = !element.muted;
    this.syncVolume(element);
  }

  /** Asks to play; the state turns to playing only when the element says so. */
  play(): void {
    const element = this.element;
    if (!element || !this.current()) return;
    if (this.state().phase === 'ended') this.seek(0);
    const loadId = this.loads;
    this.dispatch({ type: 'play-requested', loadId });
    // Asked to play a source still loading (an iPhone loads only now): if it never becomes
    // playable (the connection dropped), the stall timeout reports it (AC-12).
    if (this.state().phase === 'loading') this.armStallTimer(loadId);
    // A refused play (autoplay policy, a newer load) leaves the state as the element reports.
    element.play()?.catch((err: unknown) => this.onPlayRefused(err, loadId));
  }

  pause(): void {
    this.element?.pause();
  }

  toggle(): void {
    if (this.playing()) this.pause();
    else this.play();
  }

  /**
   * Moves to `ms` inside the media; the slider and the skips go through here. `fast` lets
   * the browser land on a nearby keyframe (the system's seek bar asks for it, FR-7).
   */
  seek(ms: number, fast = false): void {
    this.askedSeeks.update((count) => count + 1);
    this.moveTo(ms, fast);
  }

  private moveTo(ms: number, fast = false): void {
    const element = this.element;
    if (!element || !this.current()) return;
    const target = clampToDuration(ms, this.state().durationMs);
    this.dispatch({
      type: 'seek-requested',
      loadId: this.loads,
      targetMs: target,
    });
    if (fast && typeof element.fastSeek === 'function')
      element.fastSeek(target / 1000);
    else element.currentTime = target / 1000;
  }

  /**
   * Jumps over a silence (KBC-044): a seek the app makes, not the person, so it is not
   * announced as a new position and does not count as the person's skip.
   */
  skipSilence(toMs: number): void {
    if (!this.element || !this.current()) return;
    this.ownSeek = true;
    this.moveTo(toMs);
  }

  /**
   * Where the element is right now, read live: `playback().currentMs` moves only on
   * `timeupdate` (every ~250 ms), too coarse to catch a pause on time (KBC-044 NFR-2).
   */
  positionNowMs(): number {
    const element = this.element;
    return element && this.current()
      ? element.currentTime * 1000
      : this.state().currentMs;
  }

  skip(deltaMs: number): void {
    this.seek(this.state().currentMs + deltaMs);
  }

  /** After an error: reloads the same source and plays from the same second (AC-12). */
  retry(): void {
    const source = this.current();
    if (!source) return;
    this.load(source, this.state().currentMs);
    this.play();
  }

  /** Stops and releases the source without an error or a request to the page URL. */
  unload(): void {
    this.clearBuffering();
    const element = this.element;
    if (element) {
      element.pause();
      element.removeAttribute('src');
      element.load();
    }
    this.current.set(null);
    this.pendingStartMs = null;
    this.dispatch({ type: 'unload' });
  }

  private ensureElement(): HTMLMediaElement {
    if (this.element) return this.element;
    const element = this.createElement();
    this.listen(element);
    this.element = element;
    return element;
  }

  private applySpeed(element: HTMLMediaElement): void {
    const speed = this.speedValue();
    element.preservesPitch = true;
    element.defaultPlaybackRate = speed;
    element.playbackRate = speed;
  }

  private syncVolume(element: HTMLMediaElement): void {
    this.volumeValue.set(element.volume);
    this.mutedValue.set(element.muted);
  }

  private dispatch(event: PlaybackEvent): void {
    this.state.update((state) => reducePlayback(state, event));
  }

  private listen(element: HTMLMediaElement): void {
    const on = (name: MediaEventName, handle: () => void) =>
      element.addEventListener(name, () => {
        // An element left without a source (unload) reports nothing anymore.
        if (this.current()) handle();
      });
    on('loadedmetadata', () => this.onMetadata(element));
    on('durationchange', () => this.onMetadata(element));
    on('canplay', () => this.settle({ type: 'canplay', loadId: this.loads }));
    on('playing', () => {
      this.playedSinceLoad.set(true);
      this.settle({ type: 'playing', loadId: this.loads });
    });
    // Events are queued: a pause the element no longer is in (the end's own, arriving after
    // "Ouvir de novo" played again, as WebKit on Linux does) is stale and dropped.
    on('pause', () => {
      if (element.paused) this.settle({ type: 'pause', loadId: this.loads });
    });
    on('waiting', () => this.onWaiting());
    on('seeked', () => this.onSeeked(element));
    on('timeupdate', () => this.onTime(element));
    on('progress', () => this.onBuffered(element));
    on('ended', () => this.settle({ type: 'ended', loadId: this.loads }));
    on('error', () => this.onError(element));
    on('volumechange', () => this.syncVolume(element));
  }

  private onMetadata(element: HTMLMediaElement): void {
    const seconds = element.duration;
    if (!Number.isFinite(seconds)) return;
    this.dispatch({
      type: 'metadata',
      loadId: this.loads,
      durationMs: Math.round(seconds * 1000),
    });
    const start = this.pendingStartMs;
    this.pendingStartMs = null;
    if (start === null) return;
    this.ownSeek = true;
    this.moveTo(start);
  }

  /**
   * A seek to the very end while paused ends the media, though browsers fire no `ended`
   * then: "Ouvir de novo" must show all the same. Playing, the browser ends it itself.
   */
  private onSeeked(element: HTMLMediaElement): void {
    // Only the person's skips count: opening at a saved position is not one (FR-3, FR-10).
    const asked = this.state().userSeeking && !this.ownSeek;
    this.ownSeek = false;
    this.settle({ type: 'seeked', loadId: this.loads });
    if (asked) this.landedSeeks.update((count) => count + 1);
    const { durationMs } = this.state();
    const atEnd =
      durationMs !== null &&
      element.currentTime * 1000 >= durationMs - END_TOLERANCE_MS;
    if (element.paused && atEnd)
      this.dispatch({ type: 'ended', loadId: this.loads });
  }

  private onWaiting(): void {
    const loadId = this.loads;
    this.dispatch({ type: 'waiting', loadId });
    this.clearBuffering();
    this.bufferingTimer = setTimeout(
      () => this.dispatch({ type: 'buffering-elapsed', loadId }),
      BUFFERING_DEBOUNCE_MS,
    );
    this.armStallTimer(loadId);
  }

  private armStallTimer(loadId: number): void {
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(
      () => this.onStalled(loadId),
      this.stallTimeoutMs,
    );
  }

  /** Still waiting (or loading) after the stall timeout: the network is gone; say so. */
  private onStalled(loadId: number): void {
    const { waiting, phase } = this.state();
    if (loadId !== this.loads || (!waiting && phase !== 'loading')) return;
    this.element?.pause();
    this.dispatch({ type: 'error', loadId, kind: 'network' });
    this.clearBuffering();
  }

  private onTime(element: HTMLMediaElement): void {
    const currentMs = element.currentTime * 1000;
    const before = this.state().currentMs;
    this.dispatch({ type: 'time', loadId: this.loads, currentMs });
    this.onBuffered(element);
    // The clock moving on an element that is not paused is playing, even if its `playing`
    // event never comes (it can be lost after a seek from the end).
    if (!element.paused && currentMs > before && !this.playing()) {
      this.playedSinceLoad.set(true);
      this.settle({ type: 'playing', loadId: this.loads });
    }
  }

  /** The end of the buffered range that holds the current position. */
  private onBuffered(element: HTMLMediaElement): void {
    const { buffered, currentTime } = element;
    for (let i = 0; i < buffered.length; i++) {
      if (buffered.start(i) <= currentTime && currentTime <= buffered.end(i)) {
        const endMs = Math.round(buffered.end(i) * 1000);
        this.dispatch({ type: 'buffered', loadId: this.loads, endMs });
        return;
      }
    }
  }

  private onError(element: HTMLMediaElement): void {
    this.dispatch({
      type: 'error',
      loadId: this.loads,
      kind: this.errorKind(element.error?.code),
    });
    this.clearBuffering();
  }

  /**
   * Our renditions are AAC in MP4, which every browser we support plays: "source not
   * supported" (code 4) in practice means the request failed (Safari reports a dropped
   * connection that way), so it is a network error the person can retry.
   */
  private errorKind(code: number | undefined): PlaybackErrorKind {
    const kind = errorKindOf(code);
    return kind === 'unsupported' ? 'network' : kind;
  }

  private settle(event: PlaybackEvent): void {
    this.clearBuffering();
    this.dispatch(event);
  }

  private onPlayRefused(err: unknown, loadId: number): void {
    if (loadId !== this.loads) return;
    const name = err instanceof DOMException ? err.name : '';
    // NotAllowedError: no gesture yet; AbortError: a newer load replaced it. Both are normal.
    if (name !== 'NotAllowedError' && name !== 'AbortError')
      this.dispatch({ type: 'error', loadId, kind: 'unsupported' });
  }

  private clearBuffering(): void {
    if (this.bufferingTimer) clearTimeout(this.bufferingTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.bufferingTimer = null;
    this.stallTimer = null;
  }
}
