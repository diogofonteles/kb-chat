import { DecimalPipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
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
} from '@kb-chat/contracts';
import { topicsUrl } from '@core/api/kb-api.js';
import { MODE_OPTIONS } from '@core/i18n/facet-labels.js';
import { openable, treeTitle } from '@core/topics/topic-tree.js';
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
  imports: [DecimalPipe, UiChoiceCard, UiCover, UiIcon, UiSettingRow],
  templateUrl: './preferences-form.html',
  styleUrl: './settings-form.css',
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
