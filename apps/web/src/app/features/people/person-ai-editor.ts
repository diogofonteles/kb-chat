import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
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
  type PersonAi,
  type PersonAiUpdate,
} from '@kb-chat/contracts';
import { assignmentLabel } from '@features/house-ai/app-ai-labels.js';
import { parseCap, parseDaily } from '@features/house-ai/number-fields.js';
import {
  NO_LENDING,
  lendTerms,
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
  private readonly lendButton =
    viewChild<ElementRef<HTMLButtonElement>>('lendButton');
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
  /** Lending waits for the terms to be confirmed (KBC-024 BR-2). */
  protected readonly confirmingLend = signal(false);
  protected readonly terms = lendTerms;
  protected readonly unavailableNote = computed(() =>
    this.lending().canLend && !this.lending().available
      ? lendUnavailable()
      : null,
  );
  protected readonly maxCap = MAX_MONTHLY_CAP_USD;
  protected readonly maxDaily = MAX_DAILY_RESEARCHES;
  /** Why a typed number was not saved; shown on its field (MA-23). */
  protected readonly dailyError = signal<string | null>(null);
  protected readonly capError = signal<string | null>(null);

  protected chooseAppAi(value: string): void {
    if (!isAssignment(value)) return;
    if (!isLentSubscription(value)) {
      this.changed.emit({ appAi: value });
      return;
    }
    // The confirmation replaces the choice that had focus: focus follows it (WCAG 2.4.3).
    this.confirmingLend.set(true);
    afterNextRender(() => this.lendButton()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected lend(): void {
    this.confirmingLend.set(false);
    this.changed.emit({
      appAi: 'claude-subscription',
      subscriptionTermsAccepted: true,
    });
  }

  /** Back to the saved choice, with focus on the field. */
  protected cancelLend(): void {
    this.confirmingLend.set(false);
    const select = this.appAiSelect()?.nativeElement;
    if (select) select.value = this.ai().appAi;
    afterNextRender(() => this.appAiSelect()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected setEnforced(on: boolean): void {
    this.changed.emit({ enforced: on });
  }

  /** Blank: the house default; otherwise a whole number of researches a day. */
  protected setDaily(value: string): void {
    const parsed = parseDaily(value, true);
    this.dailyError.set(parsed.ok ? null : parsed.error);
    if (parsed.ok) this.changed.emit({ dailyResearches: parsed.value });
  }

  protected setPaid(enabled: boolean): void {
    const { monthlyCapUsd } = this.ai().paidFallback;
    this.changed.emit({ paidFallback: { enabled, monthlyCapUsd } });
  }

  protected setCap(value: string): void {
    const parsed = parseCap(value);
    this.capError.set(parsed.ok ? null : parsed.error);
    if (!parsed.ok) return;
    const { enabled } = this.ai().paidFallback;
    this.changed.emit({
      paidFallback: { enabled, monthlyCapUsd: parsed.value },
    });
  }
}
