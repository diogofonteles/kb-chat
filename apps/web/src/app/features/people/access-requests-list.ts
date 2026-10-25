import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { AccessRequest, Person } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { AccessRequestsStore } from '@core/auth/access-requests-store.js';

/** "+55 81 99999-0000" for a Brazilian mobile; other numbers as stored (E.164). */
export function displayPhone(phone: string): string {
  const brazil = /^\+55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return brazil ? `+55 ${brazil[1]} ${brazil[2]}-${brazil[3]}` : phone;
}

interface RowError {
  readonly id: string;
  readonly text: string;
}

/**
 * "Solicitações pendentes" (KBC-014 FR-4, screens.md T9): approve with the invite defaults
 * or refuse (24 h before asking again). Shown only when there is one.
 */
@Component({
  selector: 'app-access-requests-list',
  imports: [DatePipe],
  templateUrl: './access-requests-list.html',
  styleUrl: './access-requests-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccessRequestsList {
  protected readonly store = inject(AccessRequestsStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  /** The new person: the panel adds them and opens their editor (BR-6). */
  readonly approved = output<Person>();

  private readonly confirmButtons =
    viewChildren<ElementRef<HTMLButtonElement>>('confirmRefuse');
  private readonly refuseButtons =
    viewChildren<ElementRef<HTMLButtonElement>>('refuseButton');

  /** Each request with what the row shows, worked out once (NG-08). */
  protected readonly rows = computed(() =>
    this.store.list().map((request) => ({
      request,
      name: `${request.firstName} ${request.lastName}`.trim() || request.email,
      phone: request.phone ? displayPhone(request.phone) : null,
    })),
  );
  protected readonly busyId = signal<string | null>(null);
  protected readonly confirmingId = signal<string | null>(null);
  protected readonly error = signal<RowError | null>(null);

  constructor() {
    // A request may have arrived since the sidebar loaded the count.
    this.store.reload();
  }

  protected approve(request: AccessRequest): void {
    this.start(request.id);
    this.store
      .approve(request.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (person) => {
          this.busyId.set(null);
          this.approved.emit(person);
        },
        error: (err: unknown) => this.fail(request.id, err),
      });
  }

  /** The confirmation replaces the button that had focus: focus follows it (WCAG 2.4.3). */
  protected askRefuse(request: AccessRequest): void {
    this.confirmingId.set(request.id);
    this.focusAfterRender(() => this.confirmButtons()[0]);
  }

  protected cancelRefuse(): void {
    const id = this.confirmingId();
    this.confirmingId.set(null);
    this.focusAfterRender(() =>
      this.refuseButtons().find((b) => b.nativeElement.dataset['id'] === id),
    );
  }

  protected refuse(request: AccessRequest): void {
    this.start(request.id);
    this.store
      .refuse(request.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busyId.set(null);
          this.confirmingId.set(null);
        },
        error: (err: unknown) => this.fail(request.id, err),
      });
  }

  private start(id: string): void {
    this.busyId.set(id);
    this.error.set(null);
  }

  private fail(id: string, err: unknown): void {
    this.busyId.set(null);
    this.error.set({ id, text: errorMessage(toUiErrorCode(err)) });
  }

  private focusAfterRender(
    target: () => ElementRef<HTMLButtonElement> | undefined,
  ): void {
    afterNextRender(() => target()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }
}
