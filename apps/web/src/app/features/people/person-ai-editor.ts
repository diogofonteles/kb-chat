import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  APP_AI_ASSIGNMENTS,
  MAX_DAILY_RESEARCHES,
  isLentSubscription,
  MAX_MONTHLY_CAP_USD,
  type AppAi,
  type AppAiAssignment,
  type LentSubscription,
  type PersonAi,
  type PersonAiUpdate,
} from '@kb-chat/contracts';
import { assignmentLabel } from '@features/house-ai/app-ai-labels.js';
import { parseCap, parseDaily } from '@features/house-ai/number-fields.js';
import {
  LEND_COPY,
  NO_LENDING,
  lendUnavailable,
  type Lending,
} from './lending.js';

const isAssignment = (value: string): value is AppAiAssignment =>
  APP_AI_ASSIGNMENTS.some((option) => option === value);

/**
 * A person's AI access (KBC-022 FR-5, screens.md T9): which app AI serves them, whether it
 * wins over their own, their daily researches and the paid fallback. Each change goes up.
 */
@Component({
  selector: 'app-person-ai-editor',
  imports: [DatePipe],
  templateUrl: './person-ai-editor.html',
  styleUrl: './person-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonAiEditor {
  readonly ai = input.required<PersonAi>();
  /** The house default now, to name the "Padrão" option. */
  readonly defaultAppAi = input<AppAi | null>(null);
  readonly busy = input(false);
  /** Whether the owner's subscription is offered here (KBC-024). */
  readonly lending = input<Lending>(NO_LENDING);
  readonly changed = output<PersonAiUpdate>();
  private readonly injector = inject(Injector);
  private readonly cancelLendButton =
    viewChild<ElementRef<HTMLButtonElement>>('cancelLendButton');
  private readonly appAiSelect =
    viewChild<ElementRef<HTMLSelectElement>>('appAiSelect');

  /** The subscription is only for the owner to give; others still see it when it is set. */
  protected readonly options = computed(() =>
    APP_AI_ASSIGNMENTS.filter(
      (id) =>
        !isLentSubscription(id) ||
        this.lending().canLend ||
        this.ai().appAi === id,
    ).map((id) => ({
      id,
      label: assignmentLabel(id, this.defaultAppAi()),
    })),
  );
  protected readonly history = computed(() =>
    [...this.ai().history].reverse().map((change) => ({
      ...change,
      label: assignmentLabel(change.appAi, null),
    })),
  );
  /** A lent person's use is the owner's call: other masters may only revoke (KBC-024 F-4). */
  protected readonly lentForOthers = computed(
    () => isLentSubscription(this.ai().appAi) && !this.lending().canLend,
  );
  /** After lending, focus goes back to the choice once the save is over (QA R2-1). */
  private refocusChoice = false;
  private readonly refocusAfterSave = afterRenderEffect(() => {
    if (this.busy() || !this.refocusChoice) return;
    this.refocusChoice = false;
    this.appAiSelect()?.nativeElement.focus();
  });
  /** Lending waits for the terms of that subscription to be confirmed (KBC-024 BR-2). */
  protected readonly confirmingLend = signal<LentSubscription | null>(null);
  protected readonly lendCopy = computed(() => {
    const kind = this.confirmingLend();
    return kind ? LEND_COPY[kind] : null;
  });
  /** Said where it matters: the subscription chosen or assigned while it is not ready. */
  protected readonly unavailableNote = computed(() => {
    const { canLend, lendable } = this.lending();
    const assigned = this.ai().appAi;
    const kind =
      this.confirmingLend() ?? (isLentSubscription(assigned) ? assigned : null);
    return canLend && kind && !lendable[kind] ? lendUnavailable() : null;
  });
  protected readonly maxCap = MAX_MONTHLY_CAP_USD;
  protected readonly maxDaily = MAX_DAILY_RESEARCHES;
  /** Why a typed number was not saved; shown on its field (MA-23). */
  protected readonly dailyError = signal<string | null>(null);
  protected readonly capError = signal<string | null>(null);

  protected chooseAppAi(value: string): void {
    if (!isAssignment(value)) return;
    if (!isLentSubscription(value)) {
      // Another choice ends a pending lending: the terms never apply to it (QA BUG-1).
      this.confirmingLend.set(null);
      this.changed.emit({ appAi: value });
      return;
    }
    // The confirmation opens with focus on the safe choice (WCAG 2.4.3, design D5).
    this.confirmingLend.set(value);
    this.focusAfterRender(() => this.cancelLendButton());
  }

  protected lend(): void {
    const kind = this.confirmingLend();
    if (!kind) return;
    this.confirmingLend.set(null);
    this.changed.emit({ appAi: kind, subscriptionTermsAccepted: true });
    this.refocusChoice = true;
    this.focusAfterRender(() => this.appAiSelect());
  }

  /** Back to the saved choice, with focus on the field. */
  protected cancelLend(): void {
    this.dropLend();
    this.focusAfterRender(() => this.appAiSelect());
  }

  /** Closes a pending lending and shows the saved choice again. */
  private dropLend(): void {
    if (!this.confirmingLend()) return;
    this.confirmingLend.set(null);
    const select = this.appAiSelect()?.nativeElement;
    if (select) select.value = this.ai().appAi;
  }

  private focusAfterRender(
    target: () => ElementRef<HTMLElement> | undefined,
  ): void {
    afterNextRender(() => target()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected setEnforced(on: boolean): void {
    this.dropLend();
    this.changed.emit({ enforced: on });
  }

  /** Blank: the house default; otherwise a whole number of researches a day. */
  protected setDaily(value: string): void {
    this.dropLend();
    const parsed = parseDaily(value, true);
    this.dailyError.set(parsed.ok ? null : parsed.error);
    if (parsed.ok) this.changed.emit({ dailyResearches: parsed.value });
  }

  protected setPaid(enabled: boolean): void {
    this.dropLend();
    const { monthlyCapUsd } = this.ai().paidFallback;
    this.changed.emit({ paidFallback: { enabled, monthlyCapUsd } });
  }

  protected setCap(value: string): void {
    this.dropLend();
    const parsed = parseCap(value);
    this.capError.set(parsed.ok ? null : parsed.error);
    if (!parsed.ok) return;
    const { enabled } = this.ai().paidFallback;
    this.changed.emit({
      paidFallback: { enabled, monthlyCapUsd: parsed.value },
    });
  }
}
