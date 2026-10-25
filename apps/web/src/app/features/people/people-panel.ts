import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  LOCALE_ID,
  computed,
  inject,
  signal,
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
import { PersonEditor } from './person-editor.js';

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string } | null;

interface Outcome<T> {
  readonly done: (value: T) => string;
  /** Where a failure shows; default: next to the person it was about. */
  readonly failed?: (text: string) => void;
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
    this.run(this.api.invite(email), {
      done: (invited) => {
        this.people.update((all) => [...(all ?? []), invited]);
        this.email.set('');
        this.openId.set(invited.id);
        return $localize`:@@people.invited:Convite criado. ${invited.email}:email: já pode entrar com essa conta Google.`;
      },
      failed: (text) => this.inviteError.set(text),
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
        this.notice.set({ kind: 'ok', text: outcome.done(value) });
      },
      error: (err: unknown) => {
        this.busy.set(false);
        failed(errorMessage(toUiErrorCode(err)));
      },
    });
  }
}
