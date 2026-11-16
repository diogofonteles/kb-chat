import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterRenderEffect,
  computed,
  inject,
  linkedSignal,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { Preferences } from '@kb-chat/contracts';
import { map } from 'rxjs';
import { GoogleIdentity } from '@core/auth/google-identity.js';
import { SessionStore } from '@core/auth/session-store.js';
import { ActAsAudit } from '@features/acting/act-as-audit.js';
import { MyAccesses } from '@features/acting/my-accesses.js';
import { HouseAiPanel } from '@features/house-ai/house-ai-panel.js';
import { PeoplePanel } from '@features/people/people-panel.js';
import { ExistingTracks } from '@features/transcribers/existing-tracks.js';
import { GroqPanel } from '@features/transcribers/groq-panel.js';
import { LearningPanel } from '@features/transcribers/learning-panel.js';
import { TermsPanel } from '@features/transcribers/terms-panel.js';
import { TranscribersPanel } from '@features/transcribers/transcribers-panel.js';
import { VoiceProfilesPanel } from '@features/voice-profiles/voice-profiles-panel.js';
import {
  UiAvatar,
  UiBanner,
  UiButton,
  UiIcon,
  UiIconButton,
} from '@ui/index.js';
import { AiProviderForm } from './ai-provider-form.js';
import {
  aiDraftFrom,
  aiUpdateFrom,
  modelErrors,
  type AiDraft,
} from './ai-draft.js';
import { AiStatusCard } from './ai-status-card.js';
import { PreferencesForm } from './preferences-form.js';
import {
  GROUP_LABELS,
  SETTINGS_SECTIONS,
  folded,
  mayOpen,
  sectionBySlug,
  type SettingsGroup,
} from './settings-index.js';
import { SettingsStore, type SettingsSection } from './settings-store.js';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed' | 'invalid';

interface IndexItem {
  readonly id: SettingsSection;
  readonly slug: string;
  readonly label: string;
  readonly group: SettingsGroup;
  readonly words: string;
}

const PHONE_QUERY = '(max-width: 1023px)';
/** How far below the page's top a section title counts as read (under the strip). */
const READING_LINE = 96;
/** Room left above a section reached from the index, for the compact strip. */
const SECTION_GAP = 52;

/**
 * Configurações as a page in the main panel (KBC-131): title, the corner search, an index
 * fixed on the left (Você · Administração · Mídia · Sobre, only what the person sees) and
 * every section one after the other; scrolling marks the section in the index and the
 * address. On a phone, the root lists the groups and each section is a pushed screen.
 */
@Component({
  selector: 'app-settings-page',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    AiProviderForm,
    PreferencesForm,
    AiStatusCard,
    PeoplePanel,
    HouseAiPanel,
    TranscribersPanel,
    ExistingTracks,
    TermsPanel,
    LearningPanel,
    GroqPanel,
    VoiceProfilesPanel,
    ActAsAudit,
    MyAccesses,
    UiAvatar,
    UiBanner,
    UiButton,
    UiIcon,
    UiIconButton,
  ],
  templateUrl: './settings-page.html',
  styleUrl: './settings-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPage {
  private readonly store = inject(SettingsStore);
  private readonly session = inject(SessionStore);
  private readonly google = inject(GoogleIdentity);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly document = inject(DOCUMENT);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly view = this.document.defaultView;
  private readonly aiForm = viewChild(AiProviderForm);
  private readonly sectionEls =
    viewChildren<ElementRef<HTMLElement>>('sectionEl');
  private readonly headEl = viewChild<ElementRef<HTMLElement>>('headEl');

  /** The section in the address (/configuracoes/<slug>), null at the root. */
  private readonly routeSlug = toSignal(
    inject(ActivatedRoute).paramMap.pipe(
      map((params) => params.get('section')),
    ),
    { initialValue: null },
  );

  protected readonly phone = signal(this.matchesPhone());
  protected readonly me = this.session.me;
  protected readonly master = this.session.isMaster;
  protected readonly ownAi = this.store.ownAi;

  /** Only what the person may change (KBC-010, BR-4), in the index's order. */
  protected readonly items = computed<readonly IndexItem[]>(() => {
    const access = {
      me: this.session.me(),
      master: this.session.isMaster(),
      ownAi: this.store.ownAi(),
    };
    return SETTINGS_SECTIONS.filter(({ id }) => mayOpen(id, access)).map(
      (entry) => ({
        id: entry.id,
        slug: entry.slug,
        group: entry.group,
        label: entry.label(),
        words: folded(`${entry.label()} ${entry.keywords()}`),
      }),
    );
  });

  /** The section the address names, when the person may see it. */
  protected readonly requested = computed(() => {
    const entry = sectionBySlug(this.routeSlug());
    return this.items().find((item) => item.id === entry?.id) ?? null;
  });

  /** The index's current item: the address's, then what the scroll reached. */
  protected readonly active = linkedSignal<SettingsSection>(
    () => this.requested()?.id ?? this.items()[0]?.id ?? 'about',
  );
  protected readonly activeLabel = computed(
    () => this.items().find((item) => item.id === this.active())?.label ?? '',
  );

  protected readonly query = signal('');
  /** The corner search narrows the index (by name and a few words of each section). */
  protected readonly shownItems = computed(() => {
    const words = folded(this.query().trim());
    return words
      ? this.items().filter((item) => item.words.includes(words))
      : this.items();
  });
  protected readonly groups = computed(() => {
    const groups: {
      group: SettingsGroup;
      label: string;
      items: IndexItem[];
    }[] = [];
    for (const item of this.shownItems()) {
      const last = groups.at(-1);
      if (last?.group === item.group) last.items.push(item);
      else
        groups.push({
          group: item.group,
          label: GROUP_LABELS[item.group](),
          items: [item],
        });
    }
    return groups;
  });

  /** The page title left the screen: the compact "Configurações › Seção" strip shows. */
  protected readonly scrolled = signal(false);

  protected readonly settings = this.store.settings;
  protected readonly connectOutcome = this.store.connectOutcome;
  protected readonly loadFailed = computed(
    () => this.store.view.error() !== undefined,
  );
  protected readonly aiDraft = linkedSignal<AiDraft | null>(() => {
    const view = this.store.settings();
    return view ? aiDraftFrom(view, this.store.providerList()) : null;
  });
  protected readonly preferences = linkedSignal<Preferences | null>(
    () => this.store.settings()?.preferences ?? null,
  );
  protected readonly aiSave = signal<SaveState>('idle');
  protected readonly preferencesSave = signal<SaveState>('idle');
  protected readonly roleLabel = computed(() => {
    const me = this.session.me();
    if (!me) return '';
    const role =
      me.role === 'master'
        ? $localize`:@@settings.roleMaster:papel master`
        : $localize`:@@settings.roleMember:papel membro`;
    return me.isOwner
      ? $localize`:@@settings.roleOwner:Dono · ${role}:role:`
      : role;
  });

  /** The section scrolled to last; the scroll spy's own address changes do not scroll. */
  private scrolledTo: SettingsSection | null = null;

  constructor() {
    this.store.start();
    this.watchPhone();
    // To the section of the address once it is on screen (AC-1), and on each index choice.
    afterRenderEffect(() => {
      const target = this.requested()?.id ?? null;
      const ready = this.settings() !== null;
      const els = this.sectionEls();
      if (this.phone() || !ready || els.length === 0) return;
      untracked(() => this.scrollTo(target, els));
    });
    // Opened from the phone's "Menu" drawer (⚙, "Pessoas e permissões"): the drawer goes,
    // like after any other choice in it, or it would cover the page it opened.
    afterRenderEffect(() => {
      this.routeSlug();
      untracked(() => this.closeShellDrawer());
    });
    this.spyOnScroll();
    this.destroyRef.onDestroy(() => this.store.clearConnectOutcome());
  }

  protected setQuery(value: string): void {
    this.query.set(value);
  }

  /** Enter in the corner search: the first section found. */
  protected goToFirst(event: Event): void {
    event.preventDefault();
    const first = this.shownItems()[0];
    if (first) this.go(first.id);
  }

  /** An index entry (desktop): to its section, with the address changed. */
  protected go(id: SettingsSection): void {
    const slug = SETTINGS_SECTIONS.find((entry) => entry.id === id)?.slug;
    if (!slug) return;
    this.scrolledTo = null;
    this.active.set(id);
    if (slug === this.routeSlug()) {
      this.scrollTo(id, this.sectionEls());
      return;
    }
    void this.router.navigate(['/configuracoes', slug]);
  }

  protected back(): void {
    void this.router.navigate(['/configuracoes']);
  }

  protected signOut(): void {
    this.google.disableAutoSelect();
    // The page starts over at the login screen once the session is gone (SessionStore).
    this.session
      .signOut()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** "Configurar a minha IA" (KBC-024): to the options, where one's own AI is chosen. */
  protected focusOptions(): void {
    this.aiForm()?.focusOwnOptions();
  }

  protected editAi(draft: AiDraft): void {
    this.aiDraft.set(draft);
    this.aiSave.set('idle');
  }

  protected saveAi(): void {
    const draft = this.aiDraft();
    if (!draft) return;
    // A model the API would refuse is shown on its field, not as a failed save.
    if (Object.keys(modelErrors(draft)).length > 0) {
      this.aiSave.set('invalid');
      return;
    }
    this.aiSave.set('saving');
    this.store
      .save({ ai: aiUpdateFrom(draft) })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.aiSave.set('saved'),
        error: () => this.aiSave.set('failed'),
      });
  }

  /** Preferences apply as soon as they change, like a system settings screen. */
  protected savePreferences(preferences: Preferences): void {
    this.preferences.set(preferences);
    this.preferencesSave.set('saving');
    this.store
      .save({
        preferences: {
          ...preferences,
          defaultTopic: preferences.defaultTopic ?? null,
        },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.preferencesSave.set('saved'),
        error: () => this.preferencesSave.set('failed'),
      });
  }

  protected reopenWizard(): void {
    this.store.openOnboarding();
  }

  protected retry(): void {
    this.store.view.reload();
    this.store.providers.reload();
  }

  private scrollTo(
    target: SettingsSection | null,
    els: readonly ElementRef<HTMLElement>[],
  ): void {
    if (target === this.scrolledTo) return;
    this.scrolledTo = target;
    if (target === null) return;
    const el = els.find(
      (ref) => ref.nativeElement.dataset['section'] === target,
    );
    // Only this page scrolls: scrollIntoView would also move the shell's clipped columns.
    if (!el) return;
    const host = this.host.nativeElement;
    const offset =
      el.nativeElement.getBoundingClientRect().top -
      host.getBoundingClientRect().top;
    host.scrollTo({ top: host.scrollTop + offset - SECTION_GAP });
  }

  /**
   * The section whose title passed the reading line (just under the compact strip) is the
   * current one: the index marks it and the address follows, replacing the entry so
   * "voltar" still leaves Configurações (FR-1).
   */
  private spyOnScroll(): void {
    const host = this.host.nativeElement;
    let frame = 0;
    const onScroll = () => {
      const head = this.headEl()?.nativeElement;
      if (head)
        this.scrolled.set(
          head.getBoundingClientRect().bottom <
            host.getBoundingClientRect().top,
        );
      frame ||=
        this.view?.requestAnimationFrame(() => {
          frame = 0;
          this.readCurrent();
        }) ?? 0;
    };
    host.addEventListener('scroll', onScroll, { passive: true });
    this.destroyRef.onDestroy(() => {
      host.removeEventListener('scroll', onScroll);
      if (frame) this.view?.cancelAnimationFrame(frame);
    });
  }

  /** The last section whose title is above the reading line. */
  private readCurrent(): void {
    const line =
      this.host.nativeElement.getBoundingClientRect().top + READING_LINE;
    const els = this.sectionEls().map((ref) => ref.nativeElement);
    const passed = els.filter((el) => el.getBoundingClientRect().top <= line);
    const id = (passed.at(-1) ?? els[0])?.dataset['section'];
    const current = this.items().find((item) => item.id === id);
    if (!current || current.id === this.active()) return;
    this.active.set(current.id);
    this.scrolledTo = current.id;
    if (current.slug !== this.routeSlug())
      void this.router.navigate(['/configuracoes', current.slug], {
        replaceUrl: true,
      });
  }

  private closeShellDrawer(): void {
    for (const dialog of this.document.querySelectorAll<HTMLDialogElement>(
      'dialog[open]',
    ))
      if (dialog.querySelector('app-sidebar')) dialog.close();
  }

  private matchesPhone(): boolean {
    return this.view?.matchMedia?.(PHONE_QUERY).matches ?? false;
  }

  private watchPhone(): void {
    const query = this.view?.matchMedia?.(PHONE_QUERY);
    if (!query) return;
    const onChange = (event: MediaQueryListEvent) => {
      this.scrolledTo = null;
      this.phone.set(event.matches);
    };
    query.addEventListener('change', onChange);
    this.destroyRef.onDestroy(() =>
      query.removeEventListener('change', onChange),
    );
  }
}
