import {
  DOCUMENT,
  DatePipe,
  NgTemplateOutlet,
  formatDate,
} from '@angular/common';
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
  linkedSignal,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  topicListSchema,
  type InvitationPreset,
  type Person,
  type PersonUpdate,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { topicsUrl } from '@core/api/kb-api.js';
import { PeopleApi, type InviteSetup } from '@core/auth/auth-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { formatSpend } from '@core/spend/spend-store.js';
import {
  EMPTY,
  Subject,
  catchError,
  concatMap,
  defer,
  finalize,
  ignoreElements,
  tap,
  type Observable,
} from 'rxjs';
import { AccessRequestsList } from './access-requests-list.js';
import {
  invitationLimitOf,
  invitationStateOf,
  type InvitationState,
} from './invitation-status.js';
import {
  AiAssignmentBar,
  type AssignmentRequest,
} from './ai-assignment-bar.js';
import { HouseAiApi } from '@core/api/house-ai-api.js';
import { servingLabel } from '@features/house-ai/app-ai-labels.js';
import { NO_LENDING, type Lending } from './lending.js';
import { PersonEditor } from './person-editor.js';
import { ActAsDialog } from './act-as-dialog.js';
import { InvitePresetEditor } from './invite-preset-editor.js';
import { InviteProfilesPanel } from './invite-profiles-panel.js';
import { InviteProfilesStore } from './invite-profiles-store.js';
import { plainPreset } from './preset-defaults.js';

/** "Nenhum" in the invitation's "Perfil": today's plain invitation. */
const NO_PROFILE = 'none';

type Notice = { readonly kind: 'ok' | 'error'; readonly text: string } | null;

interface Outcome<T> {
  /** A text is a success; a notice may also say the change came back failed (KBC-026). */
  readonly done: (value: T) => string | NonNullable<Notice>;
  /** Where a failure shows; default: next to the person it was about. */
  readonly failed?: (text: string, err: unknown) => void;
}

/** A queued change; dropped when a change before it failed in the same round. */
interface Step {
  readonly round: number;
  readonly work: Observable<never>;
}

/**
 * "Pessoas e permissões" (KBC-010 FR-3, screens.md T9): invite by e-mail, then per person
 * the collections, features and the master role; revoke at any time. Masters only.
 */
@Component({
  selector: 'app-people-panel',
  imports: [
    PersonEditor,
    ActAsDialog,
    AccessRequestsList,
    AiAssignmentBar,
    InvitePresetEditor,
    InviteProfilesPanel,
    DatePipe,
    NgTemplateOutlet,
  ],
  providers: [InviteProfilesStore],
  templateUrl: './people-panel.html',
  styleUrl: './people-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PeoplePanel {
  private readonly api = inject(PeopleApi);
  private readonly houseApi = inject(HouseAiApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly session = inject(SessionStore);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  private readonly document = inject(DOCUMENT);
  /** The invitation profiles (KBC-028), shared with the profiles section. */
  protected readonly profiles = inject(InviteProfilesStore);
  private readonly rows = viewChildren<ElementRef<HTMLButtonElement>>('row');
  private readonly resendButtons =
    viewChildren<ElementRef<HTMLButtonElement>>('resendButton');

  protected readonly people = rxResource({ stream: () => this.api.list() });
  /** The house default, to name each person's "Padrão" (KBC-022). */
  private readonly house = rxResource({
    stream: () => this.houseApi.houseDefault(),
  });
  protected readonly defaultAppAi = computed(() =>
    this.house.hasValue() ? this.house.value().defaultAppAi : null,
  );
  /** Only the owner lends his subscription, and only while it is ready (KBC-024). */
  protected readonly lending = computed<Lending>(() => ({
    canLend: this.session.me()?.isOwner ?? false,
    lendable: this.house.hasValue()
      ? this.house.value().lendable
      : NO_LENDING.lendable,
  }));
  /** People chosen for a bulk AI assignment. */
  protected readonly selected = signal<ReadonlySet<string>>(new Set());
  protected readonly allSelected = computed(
    () =>
      this.list().length > 0 &&
      this.list().every((person) => this.selected().has(person.id)),
  );
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
  /** The "Perfil" picked; until then, the default profile (or "Nenhum"). */
  private readonly pickedSetup = signal<string | null>(null);
  protected readonly setupChoice = computed(
    () =>
      this.pickedSetup() ?? this.profiles.defaultProfile()?.id ?? NO_PROFILE,
  );
  protected readonly noProfile = NO_PROFILE;
  /** "Configurar agora": the preset opens from the chosen profile (KBC-028 AC-2). */
  protected readonly configuring = signal(false);
  /** A number typed in the preset is not kept yet: the invitation waits (design D4). */
  protected readonly presetInvalid = signal(false);
  /** A subscription in the preset waits for its terms: said next to "Convidar" (design R1-2). */
  protected readonly lendPending = signal(false);
  protected readonly waitsForLend = computed(
    () => this.configuring() && this.lendPending(),
  );
  protected readonly draftPreset = linkedSignal<InvitationPreset>(
    () => this.profiles.find(this.setupChoice())?.preset ?? plainPreset(),
  );
  /** What the invitation starts the person with, for the hint; '' is the plain invite. */
  protected readonly setupLabel = computed(() => {
    if (this.configuring())
      return $localize`:@@people.setupConfigured:o que você configurou abaixo`;
    const profile = this.profiles.find(this.setupChoice());
    return profile
      ? $localize`:@@people.setupProfile:o perfil "${profile.name}:name:"`
      : '';
  });
  /** Why the last invite failed, shown under the e-mail field (MA-23). */
  protected readonly inviteError = signal('');
  protected readonly openId = signal<string | null>(null);
  /** Changes waiting or on their way: one at a time, in the order they were made (KBC-062). */
  private readonly pending = signal(0);
  protected readonly busy = computed(() => this.pending() > 0);
  /** A failure ends the queue's round: what was queued on top of the failed change is dropped. */
  private round = 0;
  private readonly queue = new Subject<Step>();
  protected readonly notice = signal<Notice>(null);

  constructor() {
    this.queue
      .pipe(
        concatMap(({ round, work }) =>
          defer(() => (round === this.round ? work : EMPTY)).pipe(
            finalize(() => this.pending.update((count) => count - 1)),
          ),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  protected toggle(person: Person): void {
    this.openId.update((id) => (id === person.id ? null : person.id));
    this.notice.set(null);
  }

  protected select(person: Person, on: boolean): void {
    this.selected.update((current) => {
      const next = new Set(current);
      if (on) next.add(person.id);
      else next.delete(person.id);
      return next;
    });
  }

  protected selectAll(on: boolean): void {
    this.selected.set(new Set(on ? this.list().map((p) => p.id) : []));
  }

  /** "Aplicar às selecionadas" or "Aplicar a todos os usuários" (KBC-022 AC-12). */
  protected assign(request: AssignmentRequest): void {
    const personIds =
      request.target === 'all' ? ('all' as const) : [...this.selected()];
    const call = this.houseApi.assign({
      personIds,
      appAi: request.appAi,
      setDefault: request.setDefault,
      ...(request.subscriptionTermsAccepted && {
        subscriptionTermsAccepted: true,
      }),
    });
    this.run(call, {
      done: (updated) => {
        this.people.reload();
        if (request.setDefault) this.house.reload();
        this.selected.set(new Set());
        return $localize`:@@people.assigned:IA da aplicação atualizada para ${updated}:count: pessoa(s).`;
      },
    });
  }

  protected typeEmail(value: string): void {
    this.email.set(value);
    this.inviteError.set('');
  }

  /** Closing "Configurar agora" discards what was adjusted: the profile applies again. */
  protected toggleConfigure(): void {
    this.configuring.update((open) => !open);
    this.presetInvalid.set(false);
    this.lendPending.set(false);
  }

  protected chooseSetup(value: string): void {
    this.pickedSetup.set(value);
    this.presetInvalid.set(false);
    this.lendPending.set(false);
  }

  protected invite(event: Event): void {
    event.preventDefault();
    const email = this.email().trim();
    if (!email) return;
    const sendEmail = !this.skipEmail();
    const used = this.setupName();
    this.run(this.api.invite(email, sendEmail, this.inviteSetup()), {
      done: (invited) => {
        this.people.update((all) => [...(all ?? []), invited]);
        this.resetInvite();
        this.openId.set(invited.id);
        return withSetup(inviteNotice(invited, sendEmail), used);
      },
      failed: (text) => this.inviteError.set(text),
    });
  }

  /** The preset opened here, else the profile; "Nenhum" over a default is the plain preset. */
  private inviteSetup(): InviteSetup {
    if (this.configuring()) return { preset: this.draftPreset() };
    const choice = this.setupChoice();
    if (choice !== NO_PROFILE) return { profileId: choice };
    return this.profiles.defaultProfile() ? { preset: plainPreset() } : {};
  }

  /** The profile named in the outcome; null for the plain invitation. */
  private setupName(): string | null {
    if (this.configuring())
      return $localize`:@@people.setupOwn:configuração própria`;
    return this.profiles.find(this.setupChoice())?.name ?? null;
  }

  private resetInvite(): void {
    this.email.set('');
    this.skipEmail.set(false);
    this.pickedSetup.set(null);
    this.configuring.set(false);
    this.presetInvalid.set(false);
    this.lendPending.set(false);
  }

  /** "Aplicar perfil" (KBC-028 FR-4): role, collections, features and AI change. */
  protected applyProfile(person: Person, profileId: string): void {
    const name = this.profiles.find(profileId)?.name ?? '';
    this.run(this.api.applyProfile(person.id, profileId), {
      done: (updated) => {
        this.replace(updated);
        return $localize`:@@people.profileApplied:Perfil "${name}:name:" aplicado a ${updated.email}:email:.`;
      },
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

  /** "Ver como" (KBC-060): the owner, or a master it granted; never the owner or a master. */
  protected mayActAs(person: Person): boolean {
    return (
      this.session.me()?.canActAs === true &&
      !person.isOwner &&
      person.role !== 'master' &&
      // Before the first sign-in their data has no lasting owner yet.
      person.lastLoginAt !== null
    );
  }

  protected readonly ownerView = computed(
    () => this.session.me()?.isOwner === true,
  );
  protected readonly actingTarget = signal<Person | null>(null);
  private readonly actAsDialog = viewChild(ActAsDialog);
  private actAsOpener: HTMLElement | null = null;

  protected askActAs(person: Person): void {
    const active = this.document.activeElement;
    this.actAsOpener = active instanceof HTMLElement ? active : null;
    this.actingTarget.set(person);
    afterNextRender(() => this.actAsDialog()?.open(), {
      injector: this.injector,
    });
  }

  /** Esc or "Cancelar": the focus goes back to "Ver como" (NG-30). */
  protected actAsClosed(): void {
    this.actingTarget.set(null);
    this.actAsOpener?.focus();
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

  /** "IA: Plano da casa (sempre)": which app AI the master gave the person (KBC-022). */
  protected aiLabel(person: Person): string {
    const label = servingLabel(person.ai.appAi, this.defaultAppAi());
    return person.ai.enforced
      ? $localize`:@@people.aiEnforced:IA: ${label}:label: (sempre)`
      : $localize`:@@people.ai:IA: ${label}:label:`;
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

  /**
   * One change at a time; its outcome is announced next to what it changed. A change made
   * while another saves waits for it (KBC-062 BR-1).
   */
  private run<T>(call: Observable<T>, outcome: Outcome<T>): void {
    const failed =
      outcome.failed ??
      ((text: string) => this.notice.set({ kind: 'error', text }));
    const work = defer(() => {
      this.notice.set(null);
      return call;
    }).pipe(
      tap({
        next: (value) => {
          const done = outcome.done(value);
          this.notice.set(
            typeof done === 'string' ? { kind: 'ok', text: done } : done,
          );
        },
        error: (err: unknown) => {
          this.round++;
          failed(errorMessage(toUiErrorCode(err)), err);
        },
      }),
      ignoreElements(),
      catchError(() => EMPTY),
    );
    this.pending.update((count) => count + 1);
    this.queue.next({ round: this.round, work });
  }
}

/** The outcome also says which profile set the person up (screens.md T9). */
function withSetup(
  notice: NonNullable<Notice>,
  used: string | null,
): NonNullable<Notice> {
  if (!used) return notice;
  const suffix = $localize`:@@people.inviteProfileUsed:Perfil: ${used}:name:.`;
  return { ...notice, text: `${notice.text} ${suffix}` };
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
