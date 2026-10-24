import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import type { DocumentRef } from '@kb-chat/contracts';
import {
  citedSource,
  formatCost,
  renderAnswer,
} from '@features/answer/answer-format.js';
import { aiErrorMessage } from './research-errors.js';
import { describeSteps } from './research-steps.js';
import { citedSources, type ResearchTurn } from './research-turn.js';

/**
 * One question and the agent's answer (KBC-008 FR-3): steps line, streamed markdown with [n]
 * citations, the cited sources, the AI notice with the cost (or the subscription), and "Parar"
 * while it works.
 */
@Component({
  selector: 'app-research-message',
  templateUrl: './research-message.html',
  styleUrl: './research-message.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  // Citation links live in sanitized [innerHTML]: one delegated listener (Enter on a link also clicks).
  host: { '(click)': 'openCitation($event)' },
})
export class ResearchMessage {
  readonly turn = input.required<ResearchTurn>();
  /** Only the last turn offers "Tentar de novo" (asking again in its place). */
  readonly last = input(false);
  readonly opened = output<DocumentRef>();
  readonly stopped = output();
  readonly retried = output();

  protected readonly streaming = computed(
    () => this.turn().phase === 'streaming',
  );
  protected readonly stepsLine = computed(() => describeSteps(this.turn()));
  protected readonly html = computed(() =>
    renderAnswer(this.turn().text, this.turn().sources),
  );
  protected readonly cited = computed(() => citedSources(this.turn()));
  /** A subscription turn costs nothing per token and stays out of today's spend (KBC-007 BR-2). */
  protected readonly subscription = computed(
    () => this.turn().billing === 'subscription',
  );
  /** Per-token providers report what the turn cost. */
  protected readonly costLabel = computed(() => {
    const usd = this.turn().usd;
    return usd ? formatCost(usd) : '';
  });
  protected readonly errorText = computed(() => {
    const code = this.turn().error;
    return code ? aiErrorMessage(code) : '';
  });

  protected openCitation(event: MouseEvent): void {
    const n = citedSource(event.target);
    const source = this.turn().sources.find((s) => s.n === n);
    if (!source) return;
    event.preventDefault();
    this.opened.emit({ id: source.id, title: source.title });
  }
}
