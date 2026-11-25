import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
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
  linkedSignal,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { AiProvider, Preferences } from '@kb-chat/contracts';
import { map } from 'rxjs';
import { GoogleIdentity } from '@core/auth/google-identity.js';
import { SessionStore } from '@core/auth/session-store.js';
import { ActAsAudit } from '@features/acting/act-as-audit.js';
import { MyAccesses } from '@features/acting/my-accesses.js';
import { HouseAiPanel } from '@features/house-ai/house-ai-panel.js';
import { PeoplePanel } from '@features/people/people-panel.js';
import { ExistingTracks } from '@features/transcribers/existing-tracks.js';
import { GroqPanel } from '@features/transcribers/groq-panel.js';
import { WebSearchSettingsPanel } from '@features/web-search/web-search-settings.js';
import { LearningPanel } from '@features/transcribers/learning-panel.js';
import { TermsPanel } from '@features/transcribers/terms-panel.js';
import { TranscribersPanel } from '@features/transcribers/transcribers-panel.js';
import { RemovedDocuments } from '@features/document-removals/removed-documents.js';
import { VoiceProfilesPanel } from '@features/voice-profiles/voice-profiles-panel.js';
import {
  UiAvatar,
  UiBanner,
  UiButton,
  UiIcon,
  UiIconButton,
  UiPill,
} from '@ui/index.js';
import { AiProviderForm } from './ai-provider-form.js';
import { rootSummaries } from './root-summaries.js';
import {
  aiDraftFrom,
  aiUpdateFrom,
  modelErrors,
  type AiDraft,
} from './ai-draft.js';
import { AiStatusCard } from './ai-status-card.js';
import { PROFILE_COPY } from '@features/research/profile-copy.js';
import { PROVIDER_COPY, VIEW_COPY } from './provider-copy.js';
import { ListeningSettings } from './listening-settings.js';
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
/** How far an arrow key moves the page, as a browser's own step. */
const ARROW_STEP = 40;

/** Where a scrolling key takes `box`, or null for a key that does not scroll. */
export function scrollTargetFor(
  event: Pick<KeyboardEvent, 'key' | 'shiftKey'>,
  box: Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>,
): number | null {
  const page = Math.max(box.clientHeight - ARROW_STEP, ARROW_STEP);
  const max = box.scrollHeight - box.clientHeight;
  const at = box.scrollTop;
  const down = (step: number) => Math.min(at + step, max);
  const up = (step: number) => Math.max(at - step, 0);
  const targets: Readonly<Record<string, () => number>> = {
    End: () => max,
    Home: () => 0,
    PageDown: () => down(page),
    PageUp: () => up(page),
    ' ': () => (event.shiftKey ? up(page) : down(page)),
    ArrowDown: () => down(ARROW_STEP),
    ArrowUp: () => up(ARROW_STEP),
  };
  return Object.hasOwn(targets, event.key)
    ? (targets[event.key]?.() ?? null)
    : null;
}
/** How far below the page's top a section title counts as read (under the strip). */
const READING_LINE = 96;
/**
 * Room left above a section reached from the index, for the compact strip: its title 70 under
 * the panel's top (v2 · Configurações: Transcritores, IA da aplicação, Sobre…).
 */
const SECTION_GAP = 55;
/** How close to the end of the page counts as "cannot scroll any further". */
const BOTTOM_SLACK = 2;
/** What a person does to scroll the page themselves (the wheel, a touch, the keyboard). */
const OWN_SCROLL_EVENTS = ['wheel', 'touchmove', 'pointerdown', 'keydown'];
/** What a person does to change a section's content (a field, a chip's ✕, a choice). */
const EDIT_EVENTS = ['input', 'change', 'pointerdown', 'keydown'];

/**
 * Configurações as a page in the main panel (KBC-131): title, the corner search, an index
 * fixed on the left (Você · Administração · Mídia · Sobre, only what the person sees) and
 * every section one after the other; scrolling marks the section in the index and the
 * address. On a phone, the root lists the groups and each section is a pushed screen.
 */
const isProvider = (id: string): id is AiProvider => id in PROVIDER_COPY;

@Component({
  selector: 'app-settings-page',
  imports: [
    NgTemplateOutlet,
    RouterLink,
    AiProviderForm,
    ListeningSettings,
    PreferencesForm,
    AiStatusCard,
    PeoplePanel,
    HouseAiPanel,
    RemovedDocuments,
    TranscribersPanel,
    ExistingTracks,
    TermsPanel,
    LearningPanel,
    GroqPanel,
    WebSearchSettingsPanel,
    VoiceProfilesPanel,
    ActAsAudit,
    MyAccesses,
    UiAvatar,
    UiBanner,
    UiButton,
    UiIcon,
    UiIconButton,
    UiPill,
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
  /** The phone root's lines that need a section's own data, read only while the root shows. */
  private readonly rootLines = rootSummaries(
    (id) =>
      this.phone() &&
      this.requested() === null &&
      this.items().some((item) => item.id === id),
  );

  /** The index's current item: the address's, then what the scroll reached. */
  protected readonly active = linkedSignal<SettingsSection>(
    () => this.requested()?.id ?? this.items()[0]?.id ?? 'about',
  );
  protected readonly activeLabel = computed(
    () => this.items().find((item) => item.id === this.active())?.label ?? '',
  );

  protected readonly query = signal('');
  /** The corner search's field is open (the frame shows only its icon until then). */
  protected readonly searchOpen = signal(false);
  private readonly injector = inject(Injector);
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

  /**
   * How many times each section was chosen in the index: choosing another section draws it
   * anew, so it reads its data again, as opening a section of the v1 modal did. A section
   * the person worked in since it was drawn is kept as it is (a draft, chips, a form).
   */
  protected readonly visits = signal<Readonly<Record<string, number>>>({});
  /** The sections the person typed, pressed or chose in since they were last drawn. */
  private readonly touched = new Set<string>();

  /** The page title left the screen: the compact "Configurações › Seção" strip shows. */
  protected readonly scrolled = signal(false);

  protected readonly settings = this.store.settings;
  /** The OpenRouter outcome, said only in the section the connection started from. */
  protected readonly ownOutcome = computed(() =>
    this.store.connectFor() === 'ai' ? this.store.connectOutcome() : null,
  );
  protected readonly houseOutcome = computed(() =>
    this.store.connectFor() === 'house' ? this.store.connectOutcome() : null,
  );
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
  /** The application's AI answers this person (KBC-022): Sua IA's title says so. */
  protected readonly onAppAi = computed(() => {
    const status = this.store.aiStatus.hasValue()
      ? this.store.aiStatus.value()
      : undefined;
    return status?.source === 'app';
  });
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

  /** The phone root's profile line: the role in one word (v2 · Índice). */
  protected readonly roleWord = computed(() =>
    this.session.me()?.role === 'master'
      ? $localize`:@@settings.roleWordMaster:master`
      : $localize`:@@settings.roleWordMember:membro`,
  );

  /**
   * The phone root's line under a section (v2 · Índice): what the page already knows, the
   * AI that answers and the default view and profile. The other sections load their own
   * data only when opened, so their rows carry just the name.
   */
  protected readonly summaries = computed<
    Partial<Record<SettingsSection, string>>
  >(() => {
    const view = this.store.settings();
    if (!view) return {};
    const { preferences } = view;
    const lines: Partial<Record<SettingsSection, string>> = {
      ...this.rootLines(),
      preferences: `${VIEW_COPY[preferences.defaultView]()} · ${PROFILE_COPY[preferences.researchProfile].label()}`,
    };
    const ai = this.aiLine();
    if (ai) lines.ai = ai;
    return lines;
  });

  /** Who answers, as Sua IA's card says it: "Sua IA · OpenRouter", "IA da aplicação". */
  private readonly aiLine = computed(() => {
    const status = this.store.aiStatus.hasValue()
      ? this.store.aiStatus.value()
      : undefined;
    if (status?.source === 'app')
      return $localize`:@@settings.root.aiApp:IA da aplicação`;
    if (status?.source === 'own') {
      const id = status.provider ?? '';
      const name = isProvider(id) ? PROVIDER_COPY[id].name() : id;
      return $localize`:@@settings.root.aiOwn:Sua IA · ${name}:provider:`;
    }
    const provider = this.store.settings()?.ai.provider ?? null;
    return provider !== null ? PROVIDER_COPY[provider].name() : '';
  });

  /** The section scrolled to last; the scroll spy's own address changes do not scroll. */
  private scrolledTo: SettingsSection | null = null;
  /**
   * The section the address or the index asked for: it stays the current one, and the scroll
   * spy leaves the address alone, until the person scrolls the page themselves (BR-5).
   */
  private pinned: SettingsSection | null = null;
  /** The phone's section seen at the last render: undefined before the first one. */
  private shownOnPhone: string | null | undefined = undefined;

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
    // A phone: focus follows the pushed screen, in and back out (WCAG 2.4.3, FR-3).
    afterRenderEffect(() => {
      const slug = this.phone() ? (this.requested()?.slug ?? null) : undefined;
      const ready = this.settings() !== null;
      untracked(() => this.focusPhoneScreen(slug, ready));
    });
    this.spyOnScroll();
    this.keepPinnedInPlace();
    this.scrollByKeysFromBody();
    this.watchEdits();
    this.destroyRef.onDestroy(() => this.store.clearConnectOutcome());
  }

  protected setQuery(value: string): void {
    this.query.set(value);
  }

  /** The search icon: the field opens in its place, focused. */
  protected openSearch(): void {
    this.searchOpen.set(true);
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLInputElement>('.search input')
          ?.focus(),
      { injector: this.injector },
    );
  }

  /** A section's search icon on a phone: to the root, where the search lists sections. */
  protected searchFromScreen(): void {
    void this.router.navigate(['/configuracoes']);
    this.openSearch();
  }

  /** Escape: the field closes and the index shows everything again. */
  protected closeSearch(): void {
    this.query.set('');
    this.searchOpen.set(false);
    afterNextRender(
      () =>
        this.host.nativeElement
          .querySelector<HTMLButtonElement>('.search-toggle')
          ?.focus(),
      { injector: this.injector },
    );
  }

  /** Leaving an empty field folds it back into the icon. */
  protected leaveSearch(): void {
    if (!this.query()) this.searchOpen.set(false);
  }

  /** The phone root's "‹": out of Configurações, to the conversation (FR-6). */
  protected leave(): void {
    void this.router.navigateByUrl('/');
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
    const another = id !== this.active();
    this.active.set(id);
    this.pinned = id;
    if (another && !this.touched.has(id))
      this.visits.update((all) => ({ ...all, [id]: (all[id] ?? 0) + 1 }));
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
    this.pinned = target;
    this.align(target, els);
  }

  /** Brings a section's title just under the compact strip. */
  private align(
    target: SettingsSection,
    els: readonly ElementRef<HTMLElement>[],
  ): void {
    const el = els.find(
      (ref) => ref.nativeElement.dataset['section'] === target,
    );
    // Only this page scrolls: scrollIntoView would also move the shell's clipped columns.
    if (!el) return;
    const host = this.host.nativeElement;
    const offset =
      el.nativeElement.getBoundingClientRect().top -
      host.getBoundingClientRect().top;
    // From the page's top, a section whose title already shows in the upper half stays where
    // it is (v2 · Sua IA: the page's title, Conta, then Sua IA, marked in the index).
    if (host.scrollTop === 0 && offset < host.clientHeight / 2) return;
    // The "Você" frames (Preferências, Acessos à sua conta) draw their title 8 higher (134).
    const lift = target === 'preferences' || target === 'accesses' ? 8 : 0;
    host.scrollTo({ top: host.scrollTop + offset - SECTION_GAP + lift });
  }

  /**
   * The sections above load their data after the first scroll and grow, which would push the
   * section asked for off the screen: while it holds (BR-5), each change in a section's
   * height brings it back under the strip. The person's own scroll lets it go.
   */
  private keepPinnedInPlace(): void {
    const Observer = this.view?.ResizeObserver;
    if (!Observer) return;
    const observer = new Observer(() => {
      const target = this.pinned;
      if (target === null || this.phone()) return;
      this.align(target, this.sectionEls());
    });
    afterRenderEffect(() => {
      const els = this.sectionEls();
      untracked(() => {
        observer.disconnect();
        for (const ref of els) observer.observe(ref.nativeElement);
      });
    });
    this.destroyRef.onDestroy(() => observer.disconnect());
  }

  /**
   * The page scrolls inside the panel, not the document: with the focus on nothing (the
   * body, right after opening a section), End, Home, Page Up/Down, Space and the arrows
   * would move nothing. They move this page then; inside a field they stay the field's.
   */
  private scrollByKeysFromBody(): void {
    const host = this.host.nativeElement;
    const onKey = (event: KeyboardEvent) => {
      const active = this.document.activeElement;
      if (
        active !== this.document.body &&
        active !== this.document.documentElement
      )
        return;
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      )
        return;
      const top = scrollTargetFor(event, host);
      if (top === null) return;
      event.preventDefault();
      this.pinned = null;
      host.scrollTo({ top });
    };
    this.document.addEventListener('keydown', onKey);
    this.destroyRef.onDestroy(() =>
      this.document.removeEventListener('keydown', onKey),
    );
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
    // The person scrolls on their own: the section asked for lets the spy lead again.
    const release = () => (this.pinned = null);
    host.addEventListener('scroll', onScroll, { passive: true });
    for (const type of OWN_SCROLL_EVENTS)
      host.addEventListener(type, release, { passive: true, capture: true });
    this.destroyRef.onDestroy(() => {
      host.removeEventListener('scroll', onScroll);
      for (const type of OWN_SCROLL_EVENTS)
        host.removeEventListener(type, release, { capture: true });
      if (frame) this.view?.cancelAnimationFrame(frame);
    });
  }

  /**
   * The current section: the one asked for while it holds, else the last whose title is above
   * the reading line. At the end of the page the last sections are too short for their title
   * to get there: the last one is current then.
   */
  private readCurrent(): void {
    const host = this.host.nativeElement;
    const els = this.sectionEls().map((ref) => ref.nativeElement);
    const line = host.getBoundingClientRect().top + READING_LINE;
    const atEnd =
      host.scrollTop + host.clientHeight >= host.scrollHeight - BOTTOM_SLACK;
    const passed = els.filter((el) => el.getBoundingClientRect().top <= line);
    const reached = atEnd ? els.at(-1) : (passed.at(-1) ?? els[0]);
    const id = this.pinned ?? reached?.dataset['section'];
    const current = this.items().find((item) => item.id === id);
    if (!current || current.id === this.active()) return;
    this.active.set(current.id);
    this.scrolledTo = current.id;
    if (current.slug !== this.routeSlug())
      void this.router.navigate(['/configuracoes', current.slug], {
        replaceUrl: true,
      });
  }

  /** Marks the section a person works in, so the index does not draw it anew. */
  private watchEdits(): void {
    const host = this.host.nativeElement;
    const onEdit = (event: Event) => {
      if (!(event.target instanceof Element)) return;
      const id =
        event.target.closest<HTMLElement>('[data-section]')?.dataset['section'];
      if (id) this.touched.add(id);
    };
    for (const type of EDIT_EVENTS)
      host.addEventListener(type, onEdit, { passive: true, capture: true });
    this.destroyRef.onDestroy(() => {
      for (const type of EDIT_EVENTS)
        host.removeEventListener(type, onEdit, { capture: true });
    });
  }

  /**
   * Entering a section on a phone focuses its title; going back focuses the row of the
   * section left, so the element pressed is never lost to <body>. The first screen keeps the
   * focus where it is.
   */
  private focusPhoneScreen(
    slug: string | null | undefined,
    ready: boolean,
  ): void {
    const before = this.shownOnPhone;
    if (slug === undefined) {
      this.shownOnPhone = undefined;
      return;
    }
    // A section's title waits for its data; the root needs none.
    if (slug !== null && !ready) return;
    this.shownOnPhone = slug;
    if (before === undefined || before === slug) return;
    const host = this.host.nativeElement;
    const target =
      slug !== null
        ? host.querySelector<HTMLElement>('.screen-title')
        : before !== null
          ? host.querySelector<HTMLElement>(`.root-item[data-slug="${before}"]`)
          : null;
    target?.focus();
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
