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
  type AppAi,
  type AppAiAssignment,
} from '@kb-chat/contracts';
import { assignmentLabel } from '@features/house-ai/app-ai-labels.js';

/** What the master asked the bar to do. */
export interface AssignmentRequest {
  readonly target: 'selected' | 'all';
  readonly appAi: AppAiAssignment;
  /** With "all": the default for people invited later becomes this too. */
  readonly setDefault: boolean;
}

const isAssignment = (value: string): value is AppAiAssignment =>
  APP_AI_ASSIGNMENTS.some((option) => option === value);

/**
 * Grants or revokes an app AI for the selected people or for everyone (KBC-022 AC-12,
 * screens.md T9). Presentational: the people page applies it.
 */
@Component({
  selector: 'app-ai-assignment-bar',
  templateUrl: './ai-assignment-bar.html',
  styleUrl: './ai-assignment-bar.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AiAssignmentBar {
  readonly selectedCount = input(0);
  /** Everyone on the list, for the "todos" confirmation. */
  readonly total = input(0);
  readonly defaultAppAi = input<AppAi | null>(null);
  readonly busy = input(false);
  readonly apply = output<AssignmentRequest>();
  private readonly injector = inject(Injector);
  private readonly allButton =
    viewChild<ElementRef<HTMLButtonElement>>('allButton');
  private readonly cancelButton =
    viewChild<ElementRef<HTMLButtonElement>>('cancelButton');

  protected readonly appAi = signal<AppAiAssignment>('house');
  protected readonly alsoDefault = signal(false);
  /** "Aplicar a todos" asks first: it replaces every individual choice (UP-07). */
  protected readonly confirmingAll = signal(false);
  protected readonly chosenLabel = computed(
    () =>
      this.options().find((option) => option.id === this.appAi())?.label ?? '',
  );
  protected readonly options = computed(() =>
    APP_AI_ASSIGNMENTS.map((id) => ({
      id,
      label: assignmentLabel(id, this.defaultAppAi()),
    })),
  );
  /** The default can only become an AI, not "default" itself. */
  protected readonly canSetDefault = computed(() => this.appAi() !== 'default');

  private focusAfterRender(
    target: () => ElementRef<HTMLButtonElement> | undefined,
  ): void {
    afterNextRender(() => target()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected choose(value: string): void {
    if (isAssignment(value)) this.appAi.set(value);
  }

  /** The confirmation replaces the button that had focus: focus follows it (WCAG 2.4.3). */
  protected askAll(): void {
    this.confirmingAll.set(true);
    this.focusAfterRender(() => this.cancelButton());
  }

  protected cancelAll(): void {
    this.confirmingAll.set(false);
    this.focusAfterRender(() => this.allButton());
  }

  protected applyTo(target: AssignmentRequest['target']): void {
    if (this.confirmingAll()) this.cancelAll();
    const setDefault =
      target === 'all' && this.alsoDefault() && this.canSetDefault();
    this.apply.emit({ target, appAi: this.appAi(), setDefault });
  }
}
