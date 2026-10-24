import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import type { DocumentRef } from '@kb-chat/contracts';
import {
  citedSource,
  formatCost,
  renderAnswer,
} from '@features/answer/answer-format.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import { aiErrorMessage } from './research-errors.js';
import { describeSteps, stepText } from './research-steps.js';
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
  private readonly settings = inject(SettingsStore);

  protected readonly streaming = computed(
    () => this.turn().phase === 'streaming',
  );
  protected readonly stepsLine = computed(() => describeSteps(this.turn()));
  /** The expanded list: tool steps, and what the agent thought aloud, shown muted (ADR 0009). */
  protected readonly stepItems = computed(() =>
    this.turn().steps.map((step) => ({
      text: stepText(step),
      thought: step.kind === 'thought',
    })),
  );
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
  /** Asking again fits a failure or a stop, never a spent daily cap (that needs Settings). */
  protected readonly canRetry = computed(() => {
    const turn = this.turn();
    if (!this.last() || turn.restored) return false;
    if (turn.phase === 'error') return turn.error !== 'DAILY_CAP_REACHED';
    return turn.phase === 'done' && turn.interrupted;
  });
  protected readonly capReached = computed(
    () => this.turn().error === 'DAILY_CAP_REACHED',
  );
  /** Only a stop after the answer started has spent something worth a notice. */
  protected readonly partialCost = computed(() => {
    const turn = this.turn();
    return !turn.restored && !this.subscription() && turn.text.trim() !== '';
  });
  protected readonly errorText = computed(() => {
    const code = this.turn().error;
    return code ? aiErrorMessage(code) : '';
  });

  protected openSettings(): void {
    this.settings.openSettings();
  }

  protected openCitation(event: MouseEvent): void {
    const n = citedSource(event.target);
    const source = this.turn().sources.find((s) => s.n === n);
    if (!source) return;
    event.preventDefault();
    this.opened.emit({ id: source.id, title: source.title });
  }
}
