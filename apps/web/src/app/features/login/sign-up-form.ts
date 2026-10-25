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
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  errorMessage,
  toUiErrorCode,
  type UiErrorCode,
} from '@core/api/api-error.js';
import { AccessApi } from '@core/auth/access-api.js';
import type { Observable } from 'rxjs';
import {
  codeError,
  digitsOf,
  emailError,
  nameError,
  phoneError,
  sendFailure,
} from './login-fields.js';

type Step = 'form' | 'code' | 'done';
type Field = 'email' | 'firstName' | 'lastName' | 'phone';
type Errors = Partial<Record<Field | 'code', string>>;

const failureOf = (code: UiErrorCode): string =>
  code === 'ALREADY_INVITED'
    ? $localize`:@@signUp.hasAccess:Este e-mail já tem acesso. Volte e entre com um código ou com o Google.`
    : sendFailure(code, () => errorMessage(code));

/**
 * "Pedir acesso sem conta Google" (KBC-014 FR-1, FR-2, screens.md T10): the form, then the
 * email code; only a confirmed email becomes a pending request (BR-2).
 */
@Component({
  selector: 'app-sign-up-form',
  templateUrl: './sign-up-form.html',
  styleUrl: './login-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SignUpForm {
  private readonly api = inject(AccessApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  readonly back = output();

  private readonly codeInput =
    viewChild<ElementRef<HTMLInputElement>>('codeInput');
  private readonly title = viewChild<ElementRef<HTMLElement>>('title');

  constructor() {
    // The button that opened this form is gone: focus moves to its title (WCAG 2.4.3).
    afterNextRender(() => this.title()?.nativeElement.focus());
  }

  protected readonly step = signal<Step>('form');
  protected readonly form = signal<Record<Field, string>>({
    email: '',
    firstName: '',
    lastName: '',
    phone: '',
  });
  protected readonly code = signal('');
  protected readonly errors = signal<Errors>({});
  protected readonly failure = signal('');
  protected readonly busy = signal(false);
  protected readonly email = computed(() => this.form().email.trim());

  protected type(field: Field, value: string): void {
    this.form.update((form) => ({ ...form, [field]: value }));
    this.errors.update((errors) => ({ ...errors, [field]: '' }));
  }

  protected typeCode(value: string): void {
    this.code.set(digitsOf(value));
    this.errors.set({});
  }

  protected submit(event?: Event): void {
    event?.preventDefault();
    const { email, firstName, lastName, phone } = this.form();
    const errors: Errors = {
      email: emailError(email),
      firstName: nameError(firstName, 'first'),
      lastName: nameError(lastName, 'last'),
      phone: phoneError(phone),
    };
    this.errors.set(errors);
    if (Object.values(errors).some(Boolean)) return;
    this.run(
      this.api.signUp({ email: email.trim(), firstName, lastName, phone }),
      () => {
        this.step.set('code');
        this.code.set('');
        afterNextRender(() => this.codeInput()?.nativeElement.focus(), {
          injector: this.injector,
        });
      },
    );
  }

  protected confirm(event: Event): void {
    event.preventDefault();
    const invalid = codeError(this.code());
    this.errors.set({ code: invalid });
    if (invalid) return;
    this.run(
      this.api.confirmSignUp({ email: this.email(), code: this.code() }),
      () => this.step.set('done'),
    );
  }

  protected changeEmail(): void {
    this.step.set('form');
    this.failure.set('');
  }

  private run(call: Observable<void>, done: () => void): void {
    this.busy.set(true);
    this.failure.set('');
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: () => {
        this.busy.set(false);
        done();
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.failure.set(failureOf(toUiErrorCode(err)));
      },
    });
  }
}
