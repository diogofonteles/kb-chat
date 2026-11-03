import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { MediaHit } from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import { textParts } from '@core/text/text-parts.js';

/**
 * A spoken passage among the results (KBC-039 FR-6, screens.md T2): "♪ Áudio · Na fala"
 * and the minute, the title, the sentence with the words found marked, the author and,
 * for an automatic transcript of low confidence, the badge saying so (BR-3).
 */
@Component({
  selector: 'app-media-hit-card',
  imports: [AuthorshipBadge],
  templateUrl: './media-hit-card.html',
  styleUrl: './media-hit-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaHitCard {
  readonly hit = input.required<MediaHit>();
  readonly active = input(false);
  /** The sub-collection the audio is in, when searching its parent (ADR 0028). */
  readonly place = input<string | null>(null);
  readonly opened = output();

  protected readonly clock = computed(() => formatClock(this.hit().startMs));
  protected readonly spokenClock = computed(() => speak(this.hit().startMs));
  protected readonly parts = computed(() =>
    textParts(this.hit().text, this.hit().highlights),
  );
  protected readonly low = computed(() => this.hit().confidence === 'low');
}
