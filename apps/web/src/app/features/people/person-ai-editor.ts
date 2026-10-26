import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import {
  APP_AI_ASSIGNMENTS,
  MAX_DAILY_RESEARCHES,
  MAX_MONTHLY_CAP_USD,
  type AppAi,
  type AppAiAssignment,
  type PersonAi,
  type PersonAiUpdate,
} from '@kb-chat/contracts';
import { assignmentLabel } from '@features/house-ai/app-ai-labels.js';
import { parseCap, parseDaily } from '@features/house-ai/number-fields.js';

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
  protected readonly maxDaily = MAX_DAILY_RESEARCHES;
  /** Why a typed number was not saved; shown on its field (MA-23). */
  protected readonly dailyError = signal<string | null>(null);
  protected readonly capError = signal<string | null>(null);

  protected chooseAppAi(value: string): void {
    if (isAssignment(value)) this.changed.emit({ appAi: value });
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
