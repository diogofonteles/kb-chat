import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import type { AnswerSource, DocumentRef, SearchHit } from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { describeFacets } from '@core/i18n/facet-labels.js';
import { speak } from '@core/i18n/spoken-time.js';
import { textParts } from '@core/text/text-parts.js';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import type { TrackOpening } from '@features/research/track-opening.js';

const VISIBLE_CONCEPTS = 2;

/** Each card's own ids, so a track card can point to what describes it. */
let nextCard = 0;

/** A result or one of its copies, with the collection it opens in (KBC-048). */
export type OpenedHit = DocumentRef & { readonly topic: string };

/**
 * A track as the T22 panel opens it from the card (KBC-101 BR-11): its passage is the card's,
 * the "Na fala" one when merged, else the snippet's paragraph or the track's start.
 */
export function trackSourceOf(hit: SearchHit): AnswerSource | null {
  const { media } = hit;
  if (!media) return null;
  return {
    n: 1,
    id: hit.id,
    title: hit.title,
    authorship: hit.authorship,
    ...(hit.author && { author: hit.author }),
    media: {
      mediaId: media.mediaId,
      kind: media.kind,
      recordingTitle: media.recordingTitle,
      ...(media.ordinal && { ordinal: media.ordinal }),
      ...(media.total && { total: media.total }),
      durationMs: media.durationMs,
      confidence: media.confidence,
    },
    passages: [{ at: '', startMs: media.startMs, endMs: media.endMs }],
  };
}

/**
 * One search hit: title, snippet, facets in text and its near-identical copies (screens.md
 * T2). A track's document (KBC-101) says "♪ Faixa · 8:15 · <gravação> · faixa 3 de 12", shows
 * the spoken sentence with the words found, and opens the T22 panel on that passage.
 */
@Component({
  selector: 'app-result-card',
  imports: [AuthorshipBadge],
  templateUrl: './result-card.html',
  styleUrl: './result-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultCard {
  readonly hit = input.required<SearchHit>();
  readonly active = input(false);
  /** The sub-collection the hit is in, when searching its parent (ADR 0028). */
  readonly place = input<string | null>(null);
  readonly opened = output<OpenedHit>();
  /** A track's card opens the transcript and the player (KBC-101 FR-11). */
  readonly trackOpened = output<TrackOpening>();

  private readonly cardId = nextCard++;
  protected readonly copiesOpen = signal(false);
  protected readonly facets = computed(() => describeFacets(this.hit()));
  protected readonly concepts = computed(() =>
    this.hit().concepts.slice(0, VISIBLE_CONCEPTS).join(' · '),
  );
  protected readonly extraConcepts = computed(() =>
    Math.max(0, this.hit().concepts.length - VISIBLE_CONCEPTS),
  );
  protected readonly copiesId = computed(() => `copies-${this.hit().id}`);
  protected readonly media = computed(() => this.hit().media ?? null);
  protected readonly clock = computed(() =>
    formatClock(this.media()?.startMs ?? 0),
  );
  /** "faixa 3 de 12", when the recording has its tracks counted. */
  protected readonly ordinal = computed(() => {
    const media = this.media();
    return media?.ordinal && media.total
      ? $localize`:@@trackCard.place:faixa ${media.ordinal}:ordinal: de ${media.total}:total:`
      : '';
  });
  /** "Faixa de áudio, O que é o ritmo?, aos 8 minutos e 15 segundos" (AC-19). */
  protected readonly trackLabel = computed(() =>
    this.media()
      ? $localize`:@@trackCard.label:Faixa de áudio, ${this.hit().title}:title:, aos ${speak(this.media()?.startMs ?? 0)}:clock:`
      : null,
  );
  protected readonly idOf = (part: string) => `card-${this.cardId}-${part}`;
  /**
   * The rest of a track card, read after its name (WCAG 1.3.1, 4.1.2): the recording and its
   * place, the authorship, the passage, the sub-collection, the facets, the subjects and the
   * states; only the parts the card shows.
   */
  protected readonly trackDescription = computed(() => {
    const media = this.media();
    if (!media) return null;
    const hit = this.hit();
    const shown: Record<string, boolean> = {
      recording: true,
      authorship: hit.authorship !== undefined,
      snippet: true,
      place: this.place() !== null,
      facets: this.facets() !== '',
      concepts: this.concepts() !== '',
      states: media.confidence === 'low' || media.stale,
    };
    return Object.keys(shown)
      .filter((part) => shown[part])
      .map((part) => this.idOf(part))
      .join(' ');
  });
  /** The spoken sentence of a merged "Na fala" passage, the words found marked (BR-8). */
  protected readonly spoken = computed(() => {
    const spoken = this.media()?.spoken;
    return spoken ? textParts(spoken.text, spoken.highlights) : null;
  });

  protected open(doc: DocumentRef, event: Event): void {
    const source = doc.id === this.hit().id ? trackSourceOf(this.hit()) : null;
    if (source) {
      const trigger =
        event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
      this.trackOpened.emit({ source, at: '', trigger });
      return;
    }
    this.opened.emit({ id: doc.id, title: doc.title, topic: this.hit().topic });
  }

  protected toggleCopies(): void {
    this.copiesOpen.update((open) => !open);
  }
}
