import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { normalizePhone, type CodeChannel } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { AccessApi } from '@core/auth/access-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import type { Observable } from 'rxjs';
import {
  codeError,
  digitsOf,
  emailError,
  phoneError,
  sendFailure,
} from './login-fields.js';

type Step = 'identify' | 'code';

/**
 * "Entrar com código" (KBC-014 FR-5, screens.md T10): an email (or a phone, when SMS is
 * on) gets a one-time code, which opens the same session as Google.
 */
@Component({
  selector: 'app-code-sign-in',
  templateUrl: './code-sign-in.html',
  styleUrl: './login-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CodeSignIn {
  private readonly api = inject(AccessApi);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly injector = inject(Injector);
  readonly channels = input.required<readonly CodeChannel[]>();
  readonly back = output();

  private readonly codeInput =
    viewChild<ElementRef<HTMLInputElement>>('codeInput');

  protected readonly step = signal<Step>('identify');
  protected readonly channel = signal<CodeChannel>('email');
  protected readonly identifier = signal('');
  protected readonly code = signal('');
  protected readonly fieldError = signal('');
  protected readonly failure = signal('');
  protected readonly busy = signal(false);
  protected readonly smsAvailable = computed(() =>
    this.channels().includes('sms'),
  );

  protected chooseChannel(channel: CodeChannel): void {
    this.channel.set(channel);
    this.identifier.set('');
    this.fieldError.set('');
  }

  protected typeIdentifier(value: string): void {
    this.identifier.set(value);
    this.fieldError.set('');
  }

  protected typeCode(value: string): void {
    this.code.set(digitsOf(value));
    this.fieldError.set('');
  }

  protected send(event?: Event): void {
    event?.preventDefault();
    const value = this.identifier().trim();
    const invalid =
      this.channel() === 'sms' ? phoneError(value) : emailError(value);
    this.fieldError.set(invalid);
    if (invalid) return;
    this.run(
      this.api.requestCode({ identifier: value, channel: this.channel() }),
      () => {
        this.step.set('code');
        this.code.set('');
        afterNextRender(() => this.codeInput()?.nativeElement.focus(), {
          injector: this.injector,
        });
      },
    );
  }

  protected verify(event: Event): void {
    event.preventDefault();
    const invalid = codeError(this.code());
    this.fieldError.set(invalid);
    if (invalid) return;
    this.busy.set(true);
    this.failure.set('');
    this.session
      .verifyCode(this.sentTo(), this.code())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((code) => {
        this.busy.set(false);
        if (code) this.failure.set(errorMessage(code));
      });
  }

  protected change(): void {
    this.step.set('identify');
    this.failure.set('');
    this.fieldError.set('');
  }

  /** The identifier as the API keys it: an E.164 phone for SMS. */
  protected sentTo(): string {
    const value = this.identifier().trim();
    return this.channel() === 'sms' ? (normalizePhone(value) ?? value) : value;
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
        const code = toUiErrorCode(err);
        this.failure.set(sendFailure(code, () => errorMessage(code)));
      },
    });
  }
}
