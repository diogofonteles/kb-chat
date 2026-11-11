import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type {
  MediaHit,
  SearchFilters,
  SearchKind,
  SearchMode,
  Topic,
} from '@kb-chat/contracts';
import { errorMessage } from '@core/api/api-error.js';
import { modeLabel } from '@core/i18n/facet-labels.js';
import { injectAuthorshipLabels } from '@features/authorship/authorship-labels.js';
import { hasFilters, type ChatMessage } from './chat-message.js';
import { FilterBar } from './filter-bar.js';
import {
  activeFilters,
  toggleFilter,
  type ActiveFilter,
} from './filter-model.js';
import { KindsChoice } from './kinds-choice.js';
import type { TrackOpening } from '@features/research/track-opening.js';
import { MediaHitCard } from './media-hit-card.js';
import { mixReferences, passageKey } from './references.js';
import { ResultCard, type OpenedHit } from './result-card.js';
import { describeMediaCount, describeResultCount } from './result-count.js';
import { SearchLevelChange } from './search-level-change.js';

/** A spoken passage opened, with its place among the results (KBC-039 FR-4). */
export interface OpenedPassage {
  readonly hit: MediaHit;
  readonly position: number;
}

/** The system's answer to one question: summary, filters, cards and every state (screens.md T2). */
@Component({
  selector: 'app-result-message',
  imports: [
    ResultCard,
    MediaHitCard,
    KindsChoice,
    FilterBar,
    DecimalPipe,
    SearchLevelChange,
  ],
  templateUrl: './result-message.html',
  styleUrl: './result-message.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultMessage {
  readonly message = input.required<ChatMessage>();
  readonly topicTitle = input('');
  readonly activeId = input<string | null>(null);
  /** The passage open in the reading panel (`passageKey`), if any. */
  readonly activePassage = input<string | null>(null);
  /** The track open in the T22 panel, if any (KBC-101): its card is marked. */
  readonly activeTrack = input<string | null>(null);
  /** Every collection the person sees: names the message's sub-collections (ADR 0028). */
  readonly topics = input<readonly Topic[]>([]);
  readonly opened = output<OpenedHit>();
  readonly retried = output();
  readonly modeSwitched = output<SearchMode>();
  readonly filtersChanged = output<SearchFilters>();
  readonly moreRequested = output();
  readonly passageOpened = output<OpenedPassage>();
  readonly kindsChanged = output<SearchKind[]>();
  /** A track's card opens the T22 panel on its passage (KBC-101 FR-11). */
  readonly trackOpened = output<TrackOpening>();

  protected readonly response = computed(() => this.message().response);
  /** The message's collection and its sub-collections, by name (the "Sub-acervo" filter). */
  protected readonly topicNames = computed(() => {
    const searched = this.message().topic;
    return new Map(
      this.topics()
        .filter((one) => one.slug === searched || one.parent === searched)
        .map((one) => [one.slug, one.title]),
    );
  });
  /** Where a result is, when it is in one of the message's sub-collections. */
  protected readonly places = computed(() => {
    const names = new Map(this.topicNames());
    names.delete(this.message().topic);
    return names;
  });
  /** Documents and spoken passages, mixed by relevance (KBC-039 FR-6). */
  protected readonly references = computed(() => {
    const response = this.response();
    return response ? mixReferences(response.items, response.media) : [];
  });
  /** The cards of the track open in the panel. */
  protected readonly activeTracks = computed(() => {
    const open = this.activeTrack();
    return new Set(
      this.references()
        .filter((one) => one.kind === 'text' && one.hit.media?.mediaId === open)
        .map((one) => one.key),
    );
  });
  /** "Buscar em" shows only where the collection has audio for this person (UP-15). */
  protected readonly kindCounts = computed(() => {
    const kinds = this.response()?.kinds;
    return kinds && kinds.audio !== null ? kinds : null;
  });
  /** "3 documentos" or "3 documentos · 2 trechos na fala" (one text: no stray spaces). */
  protected readonly found = computed(() => {
    const response = this.response();
    const spoken = response?.media ?? [];
    if (spoken.length === 0) return this.count();
    // "Textos" not chosen: no "0 documentos" before the passages.
    return !this.message().kinds.includes('text')
      ? describeMediaCount(spoken)
      : `${this.count()} · ${describeMediaCount(spoken)}`;
  });
  protected readonly modeName = computed(() => modeLabel(this.message().mode));
  protected readonly count = computed(() => {
    const response = this.response();
    return response ? describeResultCount(response) : '';
  });
  protected readonly seconds = computed(
    () => (this.response()?.tookMs ?? 0) / 1000,
  );
  protected readonly error = computed(() => {
    const code = this.message().error;
    return code ? errorMessage(code) : '';
  });
  protected readonly filtered = computed(() =>
    hasFilters(this.message().filters),
  );
  /** The open collection's labels: its main author's name (KBC-049). */
  private readonly labels = injectAuthorshipLabels();
  protected readonly removable = computed(() =>
    activeFilters(this.message().filters, this.message().filterOrder, {
      topicNames: this.topicNames(),
      authorships: this.labels(),
    }),
  );
  protected readonly canTrySemantic = computed(
    () => this.message().mode !== 'semantic',
  );
  protected readonly refreshing = computed(
    () => this.message().status === 'loading' && this.response() !== null,
  );

  protected readonly passageKey = passageKey;

  protected openPassage(hit: MediaHit, index: number): void {
    this.passageOpened.emit({ hit, position: index + 1 });
  }

  protected removeFilter(filter: ActiveFilter): void {
    this.filtersChanged.emit(
      toggleFilter(this.message().filters, filter.key, filter.value),
    );
  }
}
