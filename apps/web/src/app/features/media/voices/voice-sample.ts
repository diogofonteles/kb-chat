import { DOCUMENT } from '@angular/common';
import {
  DestroyRef,
  Injectable,
  InjectionToken,
  inject,
  signal,
} from '@angular/core';
import { MediaEngine } from '@core/media/media-engine.js';

/** The element a sample plays on (tests give one whose playback is faked). */
export const SAMPLE_ELEMENT_FACTORY = new InjectionToken<
  () => HTMLAudioElement
>('SAMPLE_ELEMENT_FACTORY', {
  providedIn: 'root',
  factory: () => {
    const document = inject(DOCUMENT);
    return () => document.createElement('audio');
  },
});

/** One sample: which voice, of which stream, from where to where. */
export interface SampleRequest {
  readonly voice: number;
  readonly src: string;
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * "Ouvir amostra da Voz N" (KBC-065 FR-3): a few seconds on an element of its own, so the
 * person's position, the mini-player and "Continuar de" stay as they are. What was playing
 * pauses for the sample and goes on after it. The time range of the URL (Media Fragments)
 * loads and stops the sample; `timeupdate` stops it where a browser does not.
 */
@Injectable()
export class VoiceSample {
  private readonly engine = inject(MediaEngine);
  private readonly createElement = inject(SAMPLE_ELEMENT_FACTORY);
  private element: HTMLAudioElement | null = null;
  private endMs = 0;
  private resume = false;
  private readonly voice = signal<number | null>(null);
  private readonly failedOnce = signal(false);

  /** The voice whose sample plays now. */
  readonly playing = this.voice.asReadonly();
  /** The last sample did not play. */
  readonly failed = this.failedOnce.asReadonly();

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stop());
  }

  /** Plays the sample, or stops it when it is this voice's that plays. */
  toggle(sample: SampleRequest): void {
    const same = this.voice() === sample.voice;
    this.stop();
    if (!same) this.play(sample);
  }

  stop(): void {
    if (this.voice() === null) return;
    this.voice.set(null);
    this.element?.pause();
    if (this.resume) this.engine.play();
    this.resume = false;
  }

  private play(sample: SampleRequest): void {
    const element = this.ready();
    this.failedOnce.set(false);
    this.resume = this.engine.playing();
    this.engine.pause();
    this.endMs = sample.endMs;
    this.voice.set(sample.voice);
    element.src = `${sample.src}#t=${sample.startMs / 1000},${sample.endMs / 1000}`;
    element.play()?.catch((err: unknown) => {
      // A newer sample took the element over: not a failure of that one.
      if (!(err instanceof DOMException && err.name === 'AbortError'))
        this.fail();
    });
  }

  private ready(): HTMLAudioElement {
    if (this.element) return this.element;
    const element = this.createElement();
    element.preload = 'none';
    element.addEventListener('timeupdate', () => {
      if (element.currentTime * 1000 >= this.endMs) this.stop();
    });
    element.addEventListener('pause', () => this.stop());
    element.addEventListener('ended', () => this.stop());
    element.addEventListener('error', () => this.fail());
    this.element = element;
    return element;
  }

  private fail(): void {
    if (this.voice() === null) return;
    this.failedOnce.set(true);
    this.stop();
  }
}
