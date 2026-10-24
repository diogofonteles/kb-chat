import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type {
  DocumentRef,
  SearchFilters,
  SearchMode,
} from '@kb-chat/contracts';
import { errorMessage } from '@core/api/api-error.js';
import { modeLabel } from '@core/i18n/facet-labels.js';
import { hasFilters, type ChatMessage } from './chat-message.js';
import { FilterBar } from './filter-bar.js';
import {
  activeFilters,
  toggleFilter,
  type ActiveFilter,
} from './filter-model.js';
import { ResultCard } from './result-card.js';
import { describeResultCount } from './result-count.js';

/** The system's answer to one question: summary, filters, cards and every state (screens.md T2). */
@Component({
  selector: 'app-result-message',
  imports: [ResultCard, FilterBar, DecimalPipe],
  templateUrl: './result-message.html',
  styleUrl: './result-message.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultMessage {
  readonly message = input.required<ChatMessage>();
  readonly topicTitle = input('');
  readonly activeId = input<string | null>(null);
  readonly opened = output<DocumentRef>();
  readonly retried = output();
  readonly modeSwitched = output<SearchMode>();
  readonly filtersChanged = output<SearchFilters>();
  readonly moreRequested = output();

  protected readonly response = computed(() => this.message().response);
  protected readonly items = computed(() => this.response()?.items ?? []);
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
  protected readonly removable = computed(() =>
    activeFilters(this.message().filters),
  );
  protected readonly canTrySemantic = computed(
    () => this.message().mode !== 'semantic',
  );
  protected readonly refreshing = computed(
    () => this.message().status === 'loading' && this.response() !== null,
  );

  protected removeFilter(filter: ActiveFilter): void {
    this.filtersChanged.emit(
      toggleFilter(this.message().filters, filter.key, filter.value),
    );
  }
}
