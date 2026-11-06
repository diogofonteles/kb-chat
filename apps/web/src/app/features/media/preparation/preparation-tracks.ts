import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
  viewChild,
  DestroyRef,
} from '@angular/core';
import type { PreparationTrack } from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { TrackAudition } from '../tracks/track-audition.js';
import { TrackText } from '../tracks/track-text.js';
import { spanText, trackStatusText, whoText } from './preparation-labels.js';
import { PreparationWatch } from './preparation-watch.js';

/** A track as a row: the words already put together. */
interface TrackLine {
  readonly track: PreparationTrack;
  readonly ordinal: number;
  readonly span: string;
  readonly length: string;
  readonly who: string;
  readonly status: string;
}

const lineOf = (track: PreparationTrack, index: number): TrackLine => ({
  track,
  ordinal: index + 1,
  span: `${formatClock(track.startMs)}–${formatClock(track.endMs)}`,
  length: spanText(track.endMs - track.startMs),
  who: whoText(track),
  status: trackStatusText(track.status),
});

/**
 * The list that grows on step 2 (T20, UP-16): each track can be heard as a stretch of the
 * recording before anything ends (BR-7). A new one fades in without moving the scroll; away
 * from the end of the list, "3 faixas novas ↓" goes there instead. "Ver texto" shows what
 * the track says, one at a time, and "Ouvir" opens it too (KBC-092 FR-1, BR-5).
 */
@Component({
  selector: 'app-preparation-tracks',
  imports: [TrackText],
  templateUrl: './preparation-tracks.html',
  styleUrls: ['./preparation-buttons.css', './preparation-tracks.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreparationTracks {
  private readonly watch = inject(PreparationWatch);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly audition = inject(TrackAudition);
  private readonly end = viewChild<ElementRef<HTMLElement>>('end');

  readonly tracks = input.required<readonly PreparationTrack[]>();

  private readonly atEnd = signal(true);
  protected readonly lines = computed(() => this.tracks().map(lineOf));
  protected readonly fresh = this.watch.fresh;
  protected readonly unseen = computed(() =>
    this.atEnd() ? 0 : this.watch.unseen(),
  );
  protected readonly playing = signal<string | null>(null);
  /** The one track whose text is open (BR-5). */
  protected readonly textOpen = signal<string | null>(null);

  constructor() {
    afterNextRender(() => this.followEnd());
  }

  /** Whether the end of the list is on screen; without an observer, it counts as seen. */
  private followEnd(): void {
    const end = this.end()?.nativeElement;
    if (!end || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => {
      const visible = entry?.isIntersecting ?? true;
      this.atEnd.set(visible);
      if (visible) this.watch.markSeen();
    });
    observer.observe(end);
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  protected isPlaying(track: PreparationTrack): boolean {
    return this.audition.playing() && this.playing() === track.id;
  }

  protected listenLabel({ track, ordinal }: TrackLine): string {
    return this.isPlaying(track)
      ? $localize`:@@prep.track.stopWhich:Parar a faixa ${ordinal}:ordinal:`
      : $localize`:@@prep.track.listenWhich:Ouvir a faixa ${ordinal}:ordinal:`;
  }

  protected listen(track: PreparationTrack): void {
    if (this.isPlaying(track)) {
      this.audition.stop();
      return;
    }
    this.playing.set(track.id);
    this.textOpen.set(track.id);
    this.audition.play({ fromMs: track.startMs, toMs: track.endMs });
  }

  protected textLabel({ track, ordinal }: TrackLine): string {
    return this.textOpen() === track.id
      ? $localize`:@@prep.track.hideTextWhich:Esconder texto da faixa ${ordinal}:ordinal:`
      : $localize`:@@prep.track.showTextWhich:Ver texto da faixa ${ordinal}:ordinal:`;
  }

  /** Opening another closes this one; closing never stops the audio (BR-5). */
  protected toggleText(track: PreparationTrack): void {
    this.textOpen.update((open) => (open === track.id ? null : track.id));
  }

  protected textId(track: PreparationTrack): string {
    return `track-text-${track.id}`;
  }

  protected goToEnd(): void {
    this.end()?.nativeElement.scrollIntoView({ block: 'end' });
  }
}
