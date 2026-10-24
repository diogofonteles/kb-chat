import { DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { SearchHit, SearchMode } from '@kb-chat/contracts';
import { errorMessage } from '@core/api/api-error.js';
import { modeLabel } from '@core/i18n/facet-labels.js';
import type { ChatMessage } from './chat-message.js';
import { ResultCard } from './result-card.js';
import { describeResultCount } from './result-count.js';

/** The system's answer to one question: summary, cards and every state (screens.md T2). */
@Component({
  selector: 'app-result-message',
  imports: [ResultCard, DecimalPipe],
  templateUrl: './result-message.html',
  styleUrl: './result-message.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ResultMessage {
  readonly message = input.required<ChatMessage>();
  readonly topicTitle = input('');
  readonly activeId = input<string | null>(null);
  readonly opened = output<SearchHit>();
  readonly retried = output();
  readonly modeSwitched = output<SearchMode>();

  protected readonly items = computed(
    () => this.message().response?.items ?? [],
  );
  protected readonly modeName = computed(() => modeLabel(this.message().mode));
  protected readonly count = computed(() => {
    const response = this.message().response;
    return response ? describeResultCount(response) : '';
  });
  protected readonly seconds = computed(
    () => (this.message().response?.tookMs ?? 0) / 1000,
  );
  protected readonly error = computed(() => {
    const code = this.message().error;
    return code ? errorMessage(code) : '';
  });
  protected readonly canTrySemantic = computed(
    () => this.message().mode !== 'semantic',
  );
}
