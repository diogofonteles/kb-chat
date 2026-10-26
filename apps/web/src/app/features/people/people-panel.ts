import { DatePipe, NgTemplateOutlet, formatDate } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChildren,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  topicListSchema,
  type Person,
  type PersonUpdate,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { topicsUrl } from '@core/api/kb-api.js';
import { PeopleApi } from '@core/auth/auth-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { formatSpend } from '@core/spend/spend-store.js';
import type { Observable } from 'rxjs';
import { AccessRequestsList } from './access-requests-list.js';
import {
  invitationLimitOf,
  invitationStateOf,
  type InvitationState,
} from './invitation-status.js';
import { PersonEditor } from './person-editor.js';

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string } | null;

interface Outcome<T> {
  /** A text is a success; a notice may also say the change came back failed (KBC-026). */
  readonly done: (value: T) => string | NonNullable<Notice>;
  /** Where a failure shows; default: next to the person it was about. */
  readonly failed?: (text: string, err: unknown) => void;
}

/**
 * "Pessoas e permissões" (KBC-010 FR-3, screens.md T9): invite by e-mail, then per person
 * the collections, features and the master role; revoke at any time. Masters only.
 */
@Component({
  selector: 'app-people-panel',
  imports: [PersonEditor, AccessRequestsList, DatePipe, NgTemplateOutlet],
  templateUrl: './people-panel.html',
  styleUrl: './people-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PeoplePanel {
  private readonly api = inject(PeopleApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly session = inject(SessionStore);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  private readonly rows = viewChildren<ElementRef<HTMLButtonElement>>('row');
  private readonly resendButtons =
    viewChildren<ElementRef<HTMLButtonElement>>('resendButton');

  protected readonly people = rxResource({ stream: () => this.api.list() });
  /** Each person's AI spend today, shown to the owner only (BR-6). */
  private readonly spend = rxResource({
    params: () => this.session.me()?.isOwner || undefined,
    stream: () => this.api.spendByPerson(),
  });
  private readonly spendByEmail = computed(
    () =>
      new Map(
        (this.spend.hasValue() ? this.spend.value().items : []).map((item) => [
          item.email,
          item.usd,
        ]),
      ),
  );
  private readonly topicList = httpResource(() => topicsUrl(), {
    parse: (body) => topicListSchema.parse(body),
  });
  protected readonly topics = computed(() =>
    this.topicList.hasValue() ? this.topicList.value().items : [],
  );
  protected readonly titles = computed(
    () => new Map(this.topics().map((t) => [t.slug, t.title])),
  );
  protected readonly list = computed(() =>
    this.people.hasValue() ? this.people.value() : [],
  );
  protected readonly email = signal('');
  /** "Não enviar e-mail de convite" (KBC-026): unchecked, the invitation e-mail goes. */
  protected readonly skipEmail = signal(false);
  /** Each person's access and invitation, by id (KBC-026 FR-5). */
  protected readonly invitations = computed(
    () =>
      new Map<string, InvitationState>(
        this.list().map((person) => [person.id, invitationStateOf(person)]),
      ),
  );
  /** Why the last invite failed, shown under the e-mail field (MA-23). */
  protected readonly inviteError = signal('');
  protected readonly openId = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice>(null);

  protected toggle(person: Person): void {
    this.openId.update((id) => (id === person.id ? null : person.id));
    this.notice.set(null);
  }

  protected typeEmail(value: string): void {
    this.email.set(value);
    this.inviteError.set('');
  }

  protected invite(event: Event): void {
    event.preventDefault();
    const email = this.email().trim();
    if (!email) return;
    const sendEmail = !this.skipEmail();
    this.run(this.api.invite(email, sendEmail), {
      done: (invited) => {
        this.people.update((all) => [...(all ?? []), invited]);
        this.email.set('');
        this.skipEmail.set(false);
        this.openId.set(invited.id);
        return inviteNotice(invited, sendEmail);
      },
      failed: (text) => this.inviteError.set(text),
    });
  }

  /** "Reenviar convite" / "Enviar convite" (KBC-026 FR-6); the outcome shows next to the person. */
  protected resend(person: Person): void {
    const first = this.invitations().get(person.id)?.kind === 'none';
    this.run(this.api.resendInvitation(person.id), {
      done: (updated) => {
        this.replace(updated);
        this.refocusResend();
        if (updated.invitation?.failedAt)
          return {
            kind: 'error',
            text: $localize`:@@people.resendFailed:Não consegui enviar o e-mail. O convite continua valendo; tente de novo mais tarde.`,
          };
        return first
          ? $localize`:@@people.invitationSent:Convite enviado para ${updated.email}:email:.`
          : $localize`:@@people.resent:Convite reenviado para ${updated.email}:email:.`;
      },
      failed: (text, err) => {
        this.refocusResend();
        const retryAt = invitationLimitOf(err);
        this.notice.set({
          kind: 'error',
          text: retryAt
            ? $localize`:@@people.resendLimited:Este convite foi enviado há pouco. Você pode reenviar a partir de ${formatDate(retryAt, 'dd/MM HH:mm', this.locale)}:time:.`
            : text,
        });
      },
    });
  }

  /** An approved request is a new person: their editor opens to choose the rest (BR-6). */
  protected welcome(person: Person): void {
    this.people.update((all) => [...(all ?? []), person]);
    this.openId.set(person.id);
    this.notice.set({
      kind: 'ok',
      text: $localize`:@@people.approvedNotice:Acesso aprovado. Escolha os acervos de ${person.name || person.email}:name:.`,
    });
    // The request's buttons are gone: focus moves to the new person, scrolled into view.
    afterNextRender(
      () =>
        this.rows()
          .find((row) => row.nativeElement.dataset['id'] === person.id)
          ?.nativeElement.focus(),
      { injector: this.injector },
    );
  }

  /** The button was disabled while sending: keyboard focus goes back to it (WCAG 2.4.3). */
  private refocusResend(): void {
    afterNextRender(() => this.resendButtons()[0]?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected change(person: Person, patch: PersonUpdate): void {
    this.run(this.api.update(person.id, patch), {
      done: (updated) => {
        this.replace(updated);
        return $localize`:@@people.saved:Salvo.`;
      },
    });
  }

  protected revoke(person: Person): void {
    this.run(this.api.revoke(person.id), {
      done: () => {
        this.people.update((all) =>
          (all ?? []).filter((p) => p.id !== person.id),
        );
        this.openId.set(null);
        return $localize`:@@people.revokedNotice:Acesso de ${person.email}:email: revogado.`;
      },
    });
  }

  protected topicNames(person: Person): string {
    if (person.role === 'master')
      return $localize`:@@people.allCollections:Todos os acervos`;
    const names = person.topics.map((slug) => this.titles().get(slug) ?? slug);
    return names.length > 0
      ? names.join(', ')
      : $localize`:@@people.noCollection:Nenhum acervo`;
  }

  /** "Gasto de IA hoje: US$ 0,50" for the owner; '' for anyone else. */
  protected spendOf(person: Person): string {
    const usd = this.spendByEmail().get(person.email);
    return usd === undefined
      ? ''
      : $localize`:@@people.spendToday:Gasto de IA hoje: ${formatSpend(usd, this.locale)}:amount:`;
  }

  private replace(updated: Person): void {
    this.people.update((all) =>
      (all ?? []).map((p) => (p.id === updated.id ? updated : p)),
    );
  }

  /** One change at a time; its outcome is announced next to what it changed. */
  private run<T>(call: Observable<T>, outcome: Outcome<T>): void {
    this.busy.set(true);
    this.notice.set(null);
    const failed =
      outcome.failed ??
      ((text: string) => this.notice.set({ kind: 'error', text }));
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => {
        this.busy.set(false);
        const done = outcome.done(value);
        this.notice.set(
          typeof done === 'string' ? { kind: 'ok', text: done } : done,
        );
      },
      error: (err: unknown) => {
        this.busy.set(false);
        failed(errorMessage(toUiErrorCode(err)), err);
      },
    });
  }
}

/** What the invite did with the e-mail (KBC-026 FR-4); a failure is an error, the invite stands. */
function inviteNotice(
  invited: Person,
  sendEmail: boolean,
): NonNullable<Notice> {
  const { sentAt, failedAt } = invited.invitation ?? {};
  if (failedAt)
    return {
      kind: 'error',
      text: $localize`:@@people.inviteEmailFailed:Convite criado, mas o e-mail não foi enviado. O acesso já vale; tente "Reenviar convite" mais tarde.`,
    };
  if (sentAt)
    return {
      kind: 'ok',
      text: $localize`:@@people.invitationSent:Convite enviado para ${invited.email}:email:.`,
    };
  return {
    kind: 'ok',
    text: sendEmail
      ? $localize`:@@people.invitedRecently:Convite criado sem e-mail: ${invited.email}:email: já recebeu um convite há pouco.`
      : $localize`:@@people.invited:Convite criado sem e-mail. ${invited.email}:email: já pode entrar com o Google ou com um código por e-mail.`,
  };
}
