import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { errorMessage } from '@core/api/api-error.js';
import { AuthApi } from '@core/auth/auth-api.js';
import {
  GoogleIdentity,
  type GoogleAccountsId,
} from '@core/auth/google-identity.js';
import { SessionStore } from '@core/auth/session-store.js';
import { CodeSignIn } from './code-sign-in.js';
import { GoogleAccessRequest } from './google-access-request.js';
import { SignUpForm } from './sign-up-form.js';

/** What the login card shows: the sign-in options, a code sign-in or the sign-up form. */
type Mode = 'start' | 'code' | 'signup';

/**
 * "Entrar com Google" (KBC-010, screens.md T8): the Google Identity Services button, the
 * not-invited state and the sign-in errors. Shown by the shell while nobody is signed in.
 */
@Component({
  selector: 'app-login-page',
  imports: [CodeSignIn, GoogleAccessRequest, SignUpForm],
  templateUrl: './login-page.html',
  styleUrl: './login-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LoginPage {
  private readonly api = inject(AuthApi);
  private readonly google = inject(GoogleIdentity);
  private readonly session = inject(SessionStore);
  private readonly destroyRef = inject(DestroyRef);
  private readonly button = viewChild<ElementRef<HTMLElement>>('button');
  private readonly codeButton =
    viewChild<ElementRef<HTMLElement>>('codeButton');
  private readonly signUpButton =
    viewChild<ElementRef<HTMLElement>>('signUpButton');
  private readonly injector = inject(Injector);

  private readonly config = rxResource({ stream: () => this.api.config() });
  private readonly accounts = rxResource({
    stream: () => this.google.accounts$,
  });
  protected readonly signingIn = signal(false);
  protected readonly mode = signal<Mode>('start');

  protected readonly clientId = computed(() =>
    this.config.hasValue() ? this.config.value().googleClientId : undefined,
  );
  protected readonly notConfigured = computed(() => this.clientId() === null);
  protected readonly unavailable = computed(
    () =>
      this.config.error() !== undefined || this.accounts.error() !== undefined,
  );
  protected readonly loading = computed(
    () =>
      !this.unavailable() &&
      (this.config.isLoading() || this.accounts.isLoading()),
  );
  protected readonly notInvited = computed(
    () => this.session.state().kind === 'not-invited',
  );
  protected readonly notInvitedDetails = computed(() => {
    const state = this.session.state();
    return state.kind === 'not-invited' ? state.details : null;
  });
  /** Email always; SMS only with a provider (KBC-014 BR-9). */
  protected readonly codeChannels = computed(() =>
    this.config.hasValue()
      ? this.config.value().codeChannels
      : (['email'] as const),
  );
  protected readonly failure = computed(() => {
    const state = this.session.state();
    return state.kind === 'failed' ? errorMessage(state.code) : '';
  });

  constructor() {
    afterRenderEffect(() => {
      const host = this.button()?.nativeElement;
      const clientId = this.clientId();
      if (!host || !clientId || !this.accounts.hasValue()) return;
      this.renderButton(this.accounts.value(), host, clientId);
    });
  }

  /** Google warns when initialize runs twice: once per client id, then only the button. */
  private initializedFor: string | null = null;

  private renderButton(
    accounts: GoogleAccountsId,
    host: HTMLElement,
    clientId: string,
  ): void {
    if (this.initializedFor !== clientId) {
      accounts.initialize({
        client_id: clientId,
        callback: ({ credential }) => credential && this.signIn(credential),
        cancel_on_tap_outside: true,
        ux_mode: 'popup',
      });
      this.initializedFor = clientId;
    }
    accounts.renderButton(host, {
      type: 'standard',
      theme: 'outline',
      size: 'large',
      text: 'signin_with',
      shape: 'pill',
      locale: 'pt-BR',
      width: Math.min(320, host.clientWidth || 320),
    });
  }

  private signIn(credential: string): void {
    this.signingIn.set(true);
    this.session
      .signIn(credential)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.signingIn.set(false));
  }

  /** "Sair" on the not-invited screen: back to the button, without Google's auto sign-in. */
  protected leave(): void {
    this.google.disableAutoSelect();
    this.session.reset();
  }

  protected show(mode: Mode): void {
    const from = this.mode();
    this.mode.set(mode);
    if (mode !== 'start') return;
    // Back from a form: focus returns to the button that opened it (WCAG 2.4.3).
    const origin = from === 'code' ? this.codeButton : this.signUpButton;
    afterNextRender(() => origin()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected retry(): void {
    this.config.reload();
    this.accounts.reload();
  }
}
