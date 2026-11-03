import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import type { DocumentRef, SearchHit } from '@kb-chat/contracts';
import { describeFacets } from '@core/i18n/facet-labels.js';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';

const VISIBLE_CONCEPTS = 2;

/** A result or one of its copies, with the collection it opens in (KBC-048). */
export type OpenedHit = DocumentRef & { readonly topic: string };

/** One search hit: title, snippet, facets in text and its near-identical copies (screens.md T2). */
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

  protected readonly copiesOpen = signal(false);
  protected readonly facets = computed(() => describeFacets(this.hit()));
  protected readonly concepts = computed(() =>
    this.hit().concepts.slice(0, VISIBLE_CONCEPTS).join(' · '),
  );
  protected readonly extraConcepts = computed(() =>
    Math.max(0, this.hit().concepts.length - VISIBLE_CONCEPTS),
  );
  protected readonly copiesId = computed(() => `copies-${this.hit().id}`);

  protected open(doc: DocumentRef): void {
    this.opened.emit({ id: doc.id, title: doc.title, topic: this.hit().topic });
  }

  protected toggleCopies(): void {
    this.copiesOpen.update((open) => !open);
  }
}
