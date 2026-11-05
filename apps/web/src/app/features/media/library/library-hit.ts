import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LibraryHit as Hit } from '@kb-chat/contracts';
import { formatClock, formatDuration } from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { textParts } from '@core/text/text-parts.js';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import { playbackStartOf } from '../search-hit/passage-focus.js';

/**
 * One result of "Buscar na biblioteca" (KBC-096): ▶, the track's title, where it belongs and
 * the sentence with the words marked, at its time. Both go to that point, 2 s before it.
 */
@Component({
  selector: 'app-library-hit',
  imports: [RouterLink, AuthorshipBadge],
  templateUrl: './library-hit.html',
  styleUrl: './library-hit.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryHit {
  readonly hit = input.required<Hit>();
  readonly playing = input(false);
  readonly played = output();
  readonly opened = output();

  protected readonly item = computed(() => this.hit().item);
  protected readonly passage = computed(() => this.hit().passage);
  protected readonly ready = computed(() => this.item().status === 'ready');
  protected readonly clock = computed(() =>
    formatClock(this.passage()?.startMs ?? 0),
  );
  protected readonly spokenClock = computed(() =>
    speak(this.passage()?.startMs ?? 0),
  );
  protected readonly parts = computed(() => {
    const passage = this.passage();
    return passage ? textParts(passage.text, passage.highlights) : [];
  });
  protected readonly low = computed(() => this.passage()?.confidence === 'low');
  protected readonly bySubject = computed(() => this.hit().match === 'subject');
  /** `?t=` of the player (KBC-038 FR-5): none without a passage, so it resumes. */
  protected readonly startParams = computed(() => {
    const passage = this.passage();
    return passage ? { t: Math.floor(playbackStartOf(passage) / 1000) } : {};
  });
  protected readonly duration = computed(() => {
    const { durationMs } = this.item();
    return durationMs === null ? '' : formatDuration(durationMs);
  });
  /** The album it belongs to, or that it is the album. */
  protected readonly place = computed(() => {
    const { parent } = this.item();
    const { trackCount } = this.hit();
    if (parent?.ordinal != null)
      return $localize`:@@library.hit.track:${parent.title}:title: · faixa ${parent.ordinal}:ordinal: de ${parent.total}:total:`;
    if (parent) return parent.title;
    if (trackCount === 0) return '';
    return trackCount === 1
      ? $localize`:@@library.hit.recordingOne:Gravação completa · 1 faixa`
      : $localize`:@@library.hit.recording:Gravação completa · ${trackCount}:count: faixas`;
  });
  protected readonly playLabel = computed(() => {
    const { title } = this.item();
    if (this.playing())
      return $localize`:@@library.pauseTrack:Pausar ${title}:title:`;
    return this.passage()
      ? $localize`:@@library.hit.playPassage:Ouvir o trecho de ${title}:title: aos ${this.spokenClock()}:time:`
      : $localize`:@@library.playTrack:Ouvir ${title}:title:`;
  });
}
