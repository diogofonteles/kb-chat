import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  INITIAL_PLAYBACK,
  clampToDuration,
  errorKindOf,
  isOperable,
  reducePlayback,
  type PlaybackErrorKind,
  type PlaybackEvent,
  type PlaybackState,
} from '@kb-chat/player-core';

/** What the engine plays: a media item of the library and its stream URL. */
export interface PlayableSource {
  readonly id: string;
  readonly title: string;
  readonly src: string;
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
      return () => {
        const audio = document.createElement('audio');
        audio.hidden = true;
        audio.dataset['mediaEngine'] = '';
        document.body.append(audio);
        return audio;
      };
    },
  },
);

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
  private loads = 0;

  readonly playback = this.state.asReadonly();
  readonly source = this.current.asReadonly();
  readonly playing = computed(() => this.state().phase === 'playing');
  readonly operable = computed(() => isOperable(this.state()));

  constructor() {
    inject(DestroyRef).onDestroy(() => this.unload());
  }

  /** Loads a source (paused, never autoplay: KBC-041 BR-3); `startAtMs` seeks once ready. */
  load(source: PlayableSource, startAtMs = 0): void {
    const element = this.ensureElement();
    this.clearBuffering();
    this.loads++;
    this.current.set(source);
    this.pendingStartMs = startAtMs > 0 ? startAtMs : null;
    this.dispatch({ type: 'load', loadId: this.loads });
    element.preload = 'metadata';
    element.src = source.src;
    element.load();
    // A source that never becomes playable (the connection dropped while loading) must not
    // leave the player "loading" forever: the same stall timeout applies (AC-12).
    const loadId = this.loads;
    this.stallTimer = setTimeout(
      () => this.onStalled(loadId),
      this.stallTimeoutMs,
    );
  }

  /** Asks to play; the state turns to playing only when the element says so. */
  play(): void {
    const element = this.element;
    if (!element || !this.current()) return;
    if (this.state().phase === 'ended') this.seek(0);
    const loadId = this.loads;
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

  /** Moves to `ms` inside the media; the slider and the skips go through here. */
  seek(ms: number): void {
    const element = this.element;
    if (!element || !this.current()) return;
    const target = clampToDuration(ms, this.state().durationMs);
    this.dispatch({
      type: 'seek-requested',
      loadId: this.loads,
      targetMs: target,
    });
    element.currentTime = target / 1000;
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
    on('playing', () => this.settle({ type: 'playing', loadId: this.loads }));
    on('pause', () => this.settle({ type: 'pause', loadId: this.loads }));
    on('waiting', () => this.onWaiting());
    on('seeked', () => this.settle({ type: 'seeked', loadId: this.loads }));
    on('timeupdate', () => this.onTime(element));
    on('progress', () => this.onBuffered(element));
    on('ended', () => this.settle({ type: 'ended', loadId: this.loads }));
    on('error', () => this.onError(element));
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
    if (start !== null) this.seek(start);
  }

  private onWaiting(): void {
    const loadId = this.loads;
    this.dispatch({ type: 'waiting', loadId });
    this.clearBuffering();
    this.bufferingTimer = setTimeout(
      () => this.dispatch({ type: 'buffering-elapsed', loadId }),
      BUFFERING_DEBOUNCE_MS,
    );
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
    this.dispatch({
      type: 'time',
      loadId: this.loads,
      currentMs: element.currentTime * 1000,
    });
    this.onBuffered(element);
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
   * Safari reports a dropped connection as "source not supported" (code 4): once this
   * source has proved playable (its duration is known), code 4 means the network.
   */
  private errorKind(code: number | undefined): PlaybackErrorKind {
    const kind = errorKindOf(code);
    return kind === 'unsupported' && this.state().durationMs !== null
      ? 'network'
      : kind;
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
