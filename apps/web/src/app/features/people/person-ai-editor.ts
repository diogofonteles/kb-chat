import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  APP_AI_ASSIGNMENTS,
  MAX_MONTHLY_CAP_USD,
  type AppAi,
  type AppAiAssignment,
  type PersonAi,
  type PersonAiUpdate,
} from '@kb-chat/contracts';
import { assignmentLabel } from '@features/house-ai/app-ai-labels.js';

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
  readonly changed = output<PersonAiUpdate>();

  protected readonly options = computed(() =>
    APP_AI_ASSIGNMENTS.map((id) => ({
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
  protected readonly maxCap = MAX_MONTHLY_CAP_USD;

  protected chooseAppAi(value: string): void {
    if (isAssignment(value)) this.changed.emit({ appAi: value });
  }

  protected setEnforced(on: boolean): void {
    this.changed.emit({ enforced: on });
  }

  /** Blank: the house default; otherwise a whole number of researches a day. */
  protected setDaily(value: string): void {
    if (value.trim() === '') {
      this.changed.emit({ dailyResearches: null });
      return;
    }
    const daily = Number(value);
    if (Number.isInteger(daily) && daily >= 0 && daily <= 500)
      this.changed.emit({ dailyResearches: daily });
  }

  protected setPaid(enabled: boolean): void {
    const { monthlyCapUsd } = this.ai().paidFallback;
    this.changed.emit({ paidFallback: { enabled, monthlyCapUsd } });
  }

  protected setCap(value: string): void {
    const cap = Number(value);
    if (!Number.isFinite(cap) || cap < 0 || cap > MAX_MONTHLY_CAP_USD) return;
    const { enabled } = this.ai().paidFallback;
    this.changed.emit({ paidFallback: { enabled, monthlyCapUsd: cap } });
  }
}
