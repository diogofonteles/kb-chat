import { DatePipe, NgTemplateOutlet } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
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
import type { Observable } from 'rxjs';
import { PersonEditor } from './person-editor.js';

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string } | null;

/**
 * "Pessoas e permissões" (KBC-010 FR-3, screens.md T9): invite by e-mail, then per person
 * the collections, features and the master role; revoke at any time. Masters only.
 */
@Component({
  selector: 'app-people-panel',
  imports: [PersonEditor, DatePipe, NgTemplateOutlet],
  templateUrl: './people-panel.html',
  styleUrl: './people-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PeoplePanel {
  private readonly api = inject(PeopleApi);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly people = rxResource({ stream: () => this.api.list() });
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
  protected readonly openId = signal<string | null>(null);
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice>(null);

  protected toggle(person: Person): void {
    this.openId.update((id) => (id === person.id ? null : person.id));
    this.notice.set(null);
  }

  protected invite(event: Event): void {
    event.preventDefault();
    const email = this.email().trim();
    if (!email) return;
    this.run(this.api.invite(email), (invited) => {
      this.people.update((all) => [...(all ?? []), invited]);
      this.email.set('');
      this.openId.set(invited.id);
      return $localize`:@@people.invited:Convite criado. ${invited.email}:email: já pode entrar com essa conta Google.`;
    });
  }

  protected change(person: Person, patch: PersonUpdate): void {
    this.run(this.api.update(person.id, patch), (updated) => {
      this.replace(updated);
      return $localize`:@@people.saved:Salvo.`;
    });
  }

  protected revoke(person: Person): void {
    this.run(this.api.revoke(person.id), () => {
      this.people.update((all) =>
        (all ?? []).filter((p) => p.id !== person.id),
      );
      this.openId.set(null);
      return $localize`:@@people.revokedNotice:Acesso de ${person.email}:email: revogado.`;
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

  private replace(updated: Person): void {
    this.people.update((all) =>
      (all ?? []).map((p) => (p.id === updated.id ? updated : p)),
    );
  }

  /** One change at a time; its outcome is announced next to the list. */
  private run<T>(call: Observable<T>, done: (value: T) => string): void {
    this.busy.set(true);
    this.notice.set(null);
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => {
        this.busy.set(false);
        this.notice.set({ kind: 'ok', text: done(value) });
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.notice.set({
          kind: 'error',
          text: errorMessage(toUiErrorCode(err)),
        });
      },
    });
  }
}
