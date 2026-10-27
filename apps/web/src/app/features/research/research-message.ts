import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import type {
  DocumentRef,
  ResearchPlan,
  SweepCoverage,
} from '@kb-chat/contracts';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import {
  citedSource,
  formatCost,
  renderAnswer,
} from '@features/answer/answer-format.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import { OWN_AI_OFFER, aiErrorMessage } from './research-errors.js';
import { describeSteps, groupedSteps } from './research-steps.js';
import {
  FREE_MODELS_NOTE,
  PROGRESS_LABEL,
  coverageText,
  estimateText,
  missingText,
  progressText,
  targetText,
  unansweredText,
} from './research-sweep.js';
import {
  canContinueSweep,
  citedSources,
  groupByAuthorship,
  type ResearchTurn,
} from './research-turn.js';

/** What a sweep left: documents not analyzed, or an answer that could not be written. */
function leftText(coverage: SweepCoverage): string {
  const reason = coverage.reason ?? 'stopped';
  if (coverage.missing > 0) return missingText(coverage.missing, reason);
  return coverage.reason ? unansweredText(coverage.reason) : '';
}

/** Who paid, as the answer's footer says it (ADR 0016, ADR 0019). */
const PLAN_LABELS: Record<ResearchPlan, () => string> = {
  house: () =>
    $localize`:@@ai.planApp:IA da aplicação (cedida pelo administrador)`,
  'app-subscription': () =>
    $localize`:@@ai.planLent:IA da aplicação (assinatura do Claude do administrador)`,
  'app-chatgpt-subscription': () =>
    $localize`:@@ai.planLentGpt:IA da aplicação (assinatura do ChatGPT do administrador)`,
  own: () => $localize`:@@ai.planOwn:Sua IA`,
};

/**
 * One question and the agent's answer (KBC-008 FR-3): steps line, streamed markdown with [n]
 * citations, the cited sources, the AI notice with the cost (or the subscription), and "Parar"
 * while it works.
 */
@Component({
  selector: 'app-research-message',
  imports: [AuthorshipBadge, NgTemplateOutlet],
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
  readonly continued = output();
  private readonly settings = inject(SettingsStore);

  protected readonly streaming = computed(
    () => this.turn().phase === 'streaming',
  );
  protected readonly stepsLine = computed(() => describeSteps(this.turn()));
  /** The expanded list: tool steps, and what the agent thought aloud, shown muted (ADR 0009). */
  protected readonly stepItems = computed(() =>
    groupedSteps(this.turn().steps),
  );
  protected readonly html = computed(() =>
    renderAnswer(this.turn().text, this.turn().sources),
  );
  protected readonly cited = computed(() => citedSources(this.turn()));
  /** Mixed authorships are listed apart, the Mestre's first (KBC-020 FR-7). */
  protected readonly sourceGroups = computed(() =>
    groupByAuthorship(this.cited())?.map((group) => ({
      ...group,
      label: AUTHORSHIP_LABELS[group.authorship],
    })),
  );
  /** A subscription turn costs nothing per token and stays out of today's spend (KBC-007 BR-2). */
  protected readonly subscription = computed(
    () => this.turn().billing === 'subscription',
  );
  /** US$ 0 with the free models of the app's AI (KBC-022). */
  protected readonly free = computed(() => this.turn().billing === 'free');
  /** The model that answered (a fallback chain may hand over to another one). */
  protected readonly modelLabel = computed(() => this.turn().model);
  /** Who paid: the app's AI or the person's own (ADR 0016); null for older turns. */
  protected readonly planLabel = computed(() => {
    const plan = this.turn().plan;
    if (!plan) return '';
    return PLAN_LABELS[plan]();
  });
  /** The administrator's subscription, not the reader's (KBC-024). */
  protected readonly lentSubscription = computed(() => {
    const plan = this.turn().plan;
    return plan === 'app-subscription' || plan === 'app-chatgpt-subscription';
  });
  /** An app AI (house plan or lent subscription): researches left today. */
  protected readonly remaining = computed(() => {
    const plan = this.turn().plan;
    return plan && plan !== 'own' ? this.turn().remaining : null;
  });
  /** A spent quota or no free capacity: offer the reader their own AI. */
  protected readonly offerOwnAi = computed(() => {
    const error = this.turn().error;
    return error !== null && OWN_AI_OFFER.includes(error);
  });
  /** Per-token providers report what the turn cost. */
  protected readonly costLabel = computed(() => {
    const usd = this.turn().usd;
    return usd ? formatCost(usd) : '';
  });
  /** Asking again fits a failure or a stop, never a spent daily cap (that needs Settings). */
  protected readonly canRetry = computed(() => {
    const turn = this.turn();
    // A failed or stopped turn from the history can be asked again too (KBC-029); a sweep
    // that can go on offers that, not starting over (design review, UP-15).
    if (!this.last() || this.canContinue()) return false;
    if (turn.phase === 'error')
      return (
        turn.error !== 'DAILY_CAP_REACHED' &&
        turn.error !== 'HOUSE_QUOTA_EXHAUSTED'
      );
    return turn.phase === 'done' && turn.interrupted;
  });
  protected readonly capReached = computed(
    () => this.turn().error === 'DAILY_CAP_REACHED',
  );
  /** Only a stop after the answer started has spent something worth a notice. */
  protected readonly partialCost = computed(() => {
    const turn = this.turn();
    return (
      !turn.restored &&
      !this.subscription() &&
      !this.free() &&
      turn.text.trim() !== ''
    );
  });
  protected readonly errorText = computed(() => {
    const { error, errorLimit } = this.turn();
    return error ? aiErrorMessage(error, errorLimit) : '';
  });

  /** The sweep's estimate and progress while it runs, before the answer (KBC-030). */
  protected readonly sweep = computed(() => {
    const turn = this.turn();
    const progress = turn.sweep;
    if (!progress || turn.phase !== 'streaming' || turn.text) return null;
    return {
      estimate: estimateText(progress),
      free: progress.free ? FREE_MODELS_NOTE() : '',
      progress: progressText(progress),
      label: PROGRESS_LABEL(),
      done: progress.batchesDone,
      total: Math.max(1, progress.batches),
    };
  });
  /** The coverage the app measured, and what was left, after the turn (KBC-030). */
  protected readonly coverage = computed(() => {
    const coverage = this.turn().coverage;
    if (!coverage || this.turn().phase === 'streaming') return null;
    return {
      line: coverageText(coverage),
      target: targetText(coverage.target, coverage.phrases),
      missing: leftText(coverage),
    };
  });
  /** A sweep stopped on this page before its coverage came: what was left (QA F-3). */
  protected readonly stoppedAt = computed(() => {
    const { coverage, sweep, phase } = this.turn();
    if (coverage || !sweep || phase !== 'done') return '';
    return missingText(sweep.needed - sweep.documentsDone, 'stopped');
  });
  /** The sweep's box already says it stopped and what was left: no second note (UP-10). */
  protected readonly sweepExplainsStop = computed(() => {
    // Only a sweep stopped before any answer: an answer cut short still says "(interrompida)".
    if (this.turn().text.trim()) return false;
    return Boolean(this.coverage()?.missing) || this.stoppedAt() !== '';
  });
  protected readonly canContinue = computed(
    () => this.last() && canContinueSweep(this.turn()),
  );

  protected openSettings(): void {
    this.settings.openSettings();
  }

  /** "Conectar a minha IA": Configurações at the AI section. */
  protected openOwnAi(): void {
    this.settings.openSettings('ai');
  }

  protected openCitation(event: MouseEvent): void {
    const n = citedSource(event.target);
    const source = this.turn().sources.find((s) => s.n === n);
    if (!source) return;
    event.preventDefault();
    this.opened.emit({ id: source.id, title: source.title });
  }
}
