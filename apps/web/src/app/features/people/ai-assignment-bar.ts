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
  defaultableAppAiSchema,
  isLentSubscription,
  type AppAi,
  type AppAiAssignment,
} from '@kb-chat/contracts';
import { assignmentLabel } from '@features/house-ai/app-ai-labels.js';
import {
  LEND_COPY,
  LEND_UNAVAILABLE,
  NO_LENDING,
  noDefaultNote,
  type Lending,
} from './lending.js';

/** What the master asked the bar to do. */
export interface AssignmentRequest {
  readonly target: 'selected' | 'all';
  readonly appAi: AppAiAssignment;
  /** With "all": the default for people invited later becomes this too. */
  readonly setDefault: boolean;
  /** Lending the owner's subscription: the terms were confirmed (KBC-024). */
  readonly subscriptionTermsAccepted?: true;
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
  /** Whether the owner's subscription is offered here (KBC-024). */
  readonly lending = input<Lending>(NO_LENDING);
  readonly apply = output<AssignmentRequest>();
  private readonly injector = inject(Injector);
  private readonly allButton =
    viewChild<ElementRef<HTMLButtonElement>>('allButton');
  private readonly cancelButton =
    viewChild<ElementRef<HTMLButtonElement>>('cancelButton');
  private readonly selectedButton =
    viewChild<ElementRef<HTMLButtonElement>>('selectedButton');
  private readonly cancelLendButton =
    viewChild<ElementRef<HTMLButtonElement>>('cancelLendButton');

  protected readonly appAi = signal<AppAiAssignment>('house');
  protected readonly alsoDefault = signal(false);
  /** "Aplicar a todos" asks first: it replaces every individual choice (UP-07). */
  protected readonly confirmingAll = signal(false);
  protected readonly chosenLabel = computed(
    () =>
      this.options().find((option) => option.id === this.appAi())?.label ?? '',
  );
  protected readonly options = computed(() =>
    APP_AI_ASSIGNMENTS.filter((id) => {
      if (!isLentSubscription(id)) return true;
      const { canLend, lendable } = this.lending();
      // ChatGPT's only while it can be lent (T9).
      return canLend && (id !== 'chatgpt-subscription' || lendable[id]);
    }).map((id) => ({
      id,
      label: assignmentLabel(id, this.defaultAppAi()),
    })),
  );
  /** The default can only become an AI that is not a subscription (ADR 0019). */
  protected readonly canSetDefault = computed(
    () => defaultableAppAiSchema.safeParse(this.appAi()).success,
  );
  /** Lending waits for the terms, for the selection or for everyone (KBC-024 BR-2). */
  protected readonly confirmingLend = signal<
    AssignmentRequest['target'] | null
  >(null);
  /** The chosen subscription's copy, while one is chosen. */
  private readonly lendCopyOf = computed(() => {
    const appAi = this.appAi();
    return isLentSubscription(appAi) ? LEND_COPY[appAi] : null;
  });
  protected readonly terms = computed(() => this.lendCopyOf()?.terms() ?? '');
  protected readonly unavailableNote = computed(() => {
    const appAi = this.appAi();
    return isLentSubscription(appAi) && !this.lending().lendable[appAi]
      ? LEND_UNAVAILABLE[appAi]()
      : null;
  });
  /** Why "também para os próximos" is off with the subscription (design D9). */
  protected readonly noDefaultNote = computed(() =>
    isLentSubscription(this.appAi()) ? noDefaultNote() : null,
  );
  /** Nobody to lend to: the selection emptied while the terms were open (QA R2-4). */
  protected readonly lendEmpty = computed(
    () => this.confirmingLend() === 'selected' && this.selectedCount() === 0,
  );
  /** The scope of the lending, before its terms (design D2). */
  protected readonly lendTitle = computed(() => {
    const copy = this.lendCopyOf();
    if (!copy) return '';
    if (this.confirmingLend() === 'all') return copy.toAll(this.total());
    return this.selectedCount() === 1
      ? copy.toOne()
      : copy.toSelected(this.selectedCount());
  });

  private focusAfterRender(
    target: () => ElementRef<HTMLButtonElement> | undefined,
  ): void {
    afterNextRender(() => target()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected choose(value: string): void {
    if (!isAssignment(value)) return;
    // Another choice ends a pending confirmation: it was about the old one (QA BUG-2, R2-6).
    this.confirmingLend.set(null);
    this.confirmingAll.set(false);
    this.appAi.set(value);
  }

  /** The confirmation replaces the button that had focus: focus follows it (WCAG 2.4.3). */
  protected askAll(): void {
    // Lending to everyone has its own confirmation, which names how many people.
    if (isLentSubscription(this.appAi())) {
      this.applyTo('all');
      return;
    }
    this.confirmingAll.set(true);
    this.focusAfterRender(() => this.cancelButton());
  }

  protected cancelAll(): void {
    this.confirmingAll.set(false);
    this.focusAfterRender(() => this.allButton());
  }

  protected applyTo(target: AssignmentRequest['target']): void {
    if (this.confirmingAll()) this.cancelAll();
    if (isLentSubscription(this.appAi())) {
      this.confirmingLend.set(target);
      this.focusAfterRender(() => this.cancelLendButton());
      return;
    }
    const setDefault =
      target === 'all' && this.alsoDefault() && this.canSetDefault();
    this.apply.emit({ target, appAi: this.appAi(), setDefault });
  }

  protected lend(): void {
    const target = this.confirmingLend();
    if (!target || !isLentSubscription(this.appAi()) || this.lendEmpty())
      return;
    this.confirmingLend.set(null);
    this.apply.emit({
      target,
      appAi: this.appAi(),
      setDefault: false,
      subscriptionTermsAccepted: true,
    });
    this.focusAfterRender(() => this.openerOf(target));
  }

  /** Back to the button that opened the confirmation (review R8). */
  protected cancelLend(): void {
    const target = this.confirmingLend();
    this.confirmingLend.set(null);
    this.focusAfterRender(() => this.openerOf(target ?? 'all'));
  }

  private openerOf(target: AssignmentRequest['target']) {
    return target === 'all' ? this.allButton() : this.selectedButton();
  }
}
