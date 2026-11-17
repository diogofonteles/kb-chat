import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import type { NotInvitedDetails } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { AccessApi } from '@core/auth/access-api.js';
import { phoneError } from './login-fields.js';
import { UiAvatar } from '@ui/avatar.js';
import { UiBanner } from '@ui/banner.js';
import { UiButton } from '@ui/button.js';
import { UiIcon } from '@ui/icon.js';
import { UiPill } from '@ui/pill.js';
import type { GoogleProfile } from './google-profile.js';

type Step = 'notice' | 'form' | 'sent';

/**
 * A Google account nobody invited (KBC-014 FR-3, screens.md T8): "Solicitar acesso" with
 * the verified identity and an optional phone, or where the person's request stands.
 */
@Component({
  selector: 'app-google-access-request',
  imports: [DatePipe, UiAvatar, UiBanner, UiButton, UiIcon, UiPill],
  templateUrl: './google-access-request.html',
  styleUrl: './login-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GoogleAccessRequest {
  private readonly api = inject(AccessApi);
  private readonly destroyRef = inject(DestroyRef);
  /** Null when the API sent no ticket: only "peça a um master" is left. */
  readonly details = input.required<NotInvitedDetails | null>();
  /** The Google account that signed in, when its token could be read (the account row). */
  readonly account = input<GoogleProfile | null>(null);
  readonly left = output();

  /** The emails use Brasília time too (ADR 0011); Brazil keeps no daylight saving time. */
  protected readonly BRASILIA = '-0300';
  protected readonly step = signal<Step>('notice');
  protected readonly phone = signal('');
  protected readonly phoneProblem = signal('');
  protected readonly failure = signal('');
  protected readonly busy = signal(false);
  protected readonly state = computed(() => this.details()?.request ?? null);
  protected readonly retryAt = computed(() => {
    const state = this.state();
    return state?.status === 'refused' ? state.retryAt : null;
  });

  protected typePhone(value: string): void {
    this.phone.set(value);
    this.phoneProblem.set('');
  }

  protected send(event: Event): void {
    event.preventDefault();
    const ticket = this.details()?.ticket;
    const phone = this.phone().trim();
    const invalid = phone ? phoneError(phone) : '';
    this.phoneProblem.set(invalid);
    if (!ticket || invalid) return;
    this.busy.set(true);
    this.failure.set('');
    this.api
      .requestWithGoogle({ ticket, ...(phone && { phone }) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.step.set('sent');
        },
        error: (err: unknown) => {
          this.busy.set(false);
          this.failure.set(errorMessage(toUiErrorCode(err)));
        },
      });
  }
}
