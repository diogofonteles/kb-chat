import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { SearchHit } from '@kb-chat/contracts';
import { describeFacets } from '@core/i18n/facet-labels.js';

const VISIBLE_CONCEPTS = 2;

/** One search hit: title, snippet and facets in text (screens.md T2, SL-17). */
@Component({
  selector: 'app-result-card',
  templateUrl: './result-card.html',
  styleUrl: './result-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultCard {
  readonly hit = input.required<SearchHit>();
  readonly active = input(false);
  readonly opened = output<SearchHit>();

  protected readonly facets = computed(() => describeFacets(this.hit()));
  protected readonly concepts = computed(() =>
    this.hit().concepts.slice(0, VISIBLE_CONCEPTS).join(' · '),
  );
  protected readonly extraConcepts = computed(() =>
    Math.max(0, this.hit().concepts.length - VISIBLE_CONCEPTS),
  );
}
