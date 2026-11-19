import { formatNumber } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  model,
} from '@angular/core';
import {
  DEFAULT_VIEWS,
  RESEARCH_PROFILES,
  defaultViewSchema,
  researchProfileSchema,
  searchModeSchema,
  themeSchema,
  topicListSchema,
  type Preferences,
  type Topic,
} from '@kb-chat/contracts';
import { LibraryCounts } from '@features/sidebar/library-counts.js';
import { topicsUrl } from '@core/api/kb-api.js';
import { MODE_OPTIONS } from '@core/i18n/facet-labels.js';
import {
  defaultTopicOf,
  openable,
  treeTitle,
} from '@core/topics/topic-tree.js';
import { PROFILE_COPY } from '@features/research/profile-copy.js';
import { THEME_CHOICES, shownTheme } from '@core/theme/theme-store.js';
import { THEME_COPY, VIEW_COPY } from './provider-copy.js';
import {
  UiChoiceCard,
  UiCover,
  UiIcon,
  UiSettingRow,
  type IconName,
} from '@ui/index.js';

export type PreferenceField =
  'view' | 'profile' | 'deepen' | 'mode' | 'topic' | 'theme';

const ALL_FIELDS: readonly PreferenceField[] = [
  'view',
  'profile',
  'deepen',
  'topic',
  'mode',
  'theme',
];

/**
 * Default view, research profile (KBC-011), collection, search mode and theme (KBC-007);
 * one field per wizard step. v2 (KBC-131): choice cards, a toggle and rows with the control
 * on the right.
 */
@Component({
  selector: 'app-preferences-form',
  imports: [UiChoiceCard, UiCover, UiIcon, UiSettingRow],
  templateUrl: './preferences-form.html',
  styleUrl: './settings-form.css',
  host: { '[class.in-wizard]': 'wizard()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreferencesForm {
  readonly preferences = model.required<Preferences>();
  readonly fields = input<readonly PreferenceField[]>(ALL_FIELDS);
  /** The wizard shows the collection and the theme as large cards (KBC-131 FR-4). */
  readonly variant = input<'settings' | 'wizard'>('settings');
  protected readonly wizard = computed(() => this.variant() === 'wizard');

  /** Only a form that shows the collection field asks for the collections. */
  private readonly topicList = httpResource(
    () => (this.shows('topic') ? topicsUrl() : undefined),
    {
      parse: (body) => topicListSchema.parse(body),
    },
  );
  /** Collections the person opens, as a tree (KBC-048). */
  protected readonly topics = computed(() =>
    this.topicList.hasValue() ? openable(this.topicList.value().items) : [],
  );
  protected readonly treeTitle = treeTitle;
  private readonly counts = inject(LibraryCounts);
  private readonly locale = inject(LOCALE_ID);
  /** The collection that opens when none is chosen ("O maior acervo"), as the chat opens it. */
  private readonly largestSlug = computed(() =>
    this.topicList.hasValue() ? defaultTopicOf(this.topicList.value()) : null,
  );
  /**
   * The wizard's collections (v2 · Assistente, passo 3): one card each, the one that opens
   * now first and chosen while the person chose none.
   */
  protected readonly wizardTopics = computed(() => {
    const first = this.largestSlug();
    const topics = this.topics();
    return [
      ...topics.filter((one) => one.slug === first),
      ...topics.filter((one) => one.slug !== first),
    ];
  });
  protected readonly chosenTopic = computed(
    () => this.preferences().defaultTopic ?? this.largestSlug(),
  );

  /** "22 documentos", "11 áudios · 1 documento" (the audio first, as Sua biblioteca). */
  protected wizardMeta(topic: Topic): string {
    const count = formatNumber(topic.documentCount, this.locale);
    const documents =
      topic.documentCount === 1
        ? $localize`:@@library.documentsOne:1 documento`
        : $localize`:@@library.documentsMany:${count}:count: documentos`;
    const children = this.topics()
      .filter((one) => one.parent === topic.slug)
      .map((one) => one.slug);
    const media = this.counts.mediaIn(topic.slug, children) ?? 0;
    if (media === 0) return documents;
    const audio = formatNumber(media, this.locale);
    const heard =
      media === 1
        ? $localize`:@@library.collectionAudioOne:1 áudio`
        : $localize`:@@library.collectionAudioMany:${audio}:count: áudios`;
    return $localize`:@@prefs.topicWithAudio:${heard}:audio: · ${documents}:documents:`;
  }
  protected readonly views = DEFAULT_VIEWS.map((value) => ({
    value,
    label: VIEW_COPY[value](),
    icon: (value === 'research' ? 'sparkle' : 'search') satisfies IconName,
    help:
      value === 'research'
        ? $localize`:@@prefs.viewResearchHint:Pergunte e a IA pesquisa o acervo e responde com as fontes.`
        : $localize`:@@prefs.viewSearchHint:Busca sem IA: cartões, filtros e o documento ao lado.`,
  }));
  protected readonly profiles = RESEARCH_PROFILES.map((value) => ({
    value,
    label: PROFILE_COPY[value].label(),
    help: PROFILE_COPY[value].help(),
  }));
  /** The frame's short names: "Tudo" reads as "As duas formas" in a setting. */
  protected readonly modes = MODE_OPTIONS.map((mode) => ({
    ...mode,
    short:
      mode.value === 'all'
        ? $localize`:@@prefs.modeAll:As duas formas`
        : mode.label,
  }));
  protected readonly themes = THEME_CHOICES.map((value) => ({
    value,
    label: THEME_COPY[value](),
  }));
  /**
   * The wizard's three themes (v2 · Assistente, passo 4: "Claro, escuro ou o esotérico."):
   * the revised dark is its "Escuro"; the old dark and Automático stay in Preferências.
   */
  protected readonly wizardThemes = [
    { value: 'light', label: THEME_COPY.light() },
    {
      value: 'revised',
      label: $localize`:@@wizard.themeDark:Escuro`,
    },
    { value: 'esoteric', label: THEME_COPY.esoteric() },
  ] as const;
  /** The selects' values in words, as a phone draws them under their labels. */
  protected readonly topicValue = computed(() => {
    const slug = this.preferences().defaultTopic;
    const topic = this.topics().find((one) => one.slug === slug);
    if (!topic) return $localize`:@@prefs.topicAuto:O maior acervo`;
    return treeTitle(topic);
  });
  protected readonly modeValue = computed(
    () =>
      this.modes.find((mode) => mode.value === this.preferences().searchMode)
        ?.short ?? '',
  );
  protected readonly themeValue = computed(
    () =>
      this.themes.find((theme) => theme.value === this.shownTheme())?.label ??
      '',
  );
  /** Nothing chosen ("auto") shows as the revised theme, the default (KBC-124 D2). */
  protected readonly shownTheme = computed(() =>
    shownTheme(this.preferences().theme),
  );

  protected shows(field: PreferenceField): boolean {
    return this.fields().includes(field);
  }

  protected setView(value: string): void {
    const parsed = defaultViewSchema.safeParse(value);
    if (parsed.success)
      this.preferences.update((p) => ({ ...p, defaultView: parsed.data }));
  }

  protected setProfile(value: string): void {
    const parsed = researchProfileSchema.safeParse(value);
    if (parsed.success)
      this.preferences.update((p) => ({ ...p, researchProfile: parsed.data }));
  }

  protected setAutoDeepen(on: boolean): void {
    this.preferences.update((p) => ({ ...p, autoDeepen: on }));
  }

  protected setMode(value: string): void {
    const parsed = searchModeSchema.safeParse(value);
    if (parsed.success)
      this.preferences.update((p) => ({ ...p, searchMode: parsed.data }));
  }

  protected setTheme(value: string): void {
    const parsed = themeSchema.safeParse(value);
    if (parsed.success)
      this.preferences.update((p) => ({ ...p, theme: parsed.data }));
  }

  /** '' = the largest collection (or KB_TOPIC), as before. */
  protected setTopic(value: string): void {
    this.preferences.update((p) => {
      const next = { ...p };
      delete next.defaultTopic;
      return value ? { ...next, defaultTopic: value } : next;
    });
  }
}
