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
  THEMES,
  defaultViewSchema,
  researchProfileSchema,
  searchModeSchema,
  themeSchema,
  topicListSchema,
  type Preferences,
} from '@kb-chat/contracts';
import { topicsUrl } from '@core/api/kb-api.js';
import { MODE_OPTIONS } from '@core/i18n/facet-labels.js';
import { PROFILE_COPY } from '@features/research/profile-copy.js';
import { THEME_COPY, VIEW_COPY } from './provider-copy.js';

export type PreferenceField = 'view' | 'profile' | 'mode' | 'topic' | 'theme';

const ALL_FIELDS: readonly PreferenceField[] = [
  'view',
  'profile',
  'topic',
  'mode',
  'theme',
];

/**
 * Default view, research profile (KBC-011), collection, search mode and theme (KBC-007);
 * one field per wizard step.
 */
@Component({
  selector: 'app-preferences-form',
  imports: [DecimalPipe],
  templateUrl: './preferences-form.html',
  styleUrl: './settings-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PreferencesForm {
  readonly preferences = model.required<Preferences>();
  readonly fields = input<readonly PreferenceField[]>(ALL_FIELDS);

  /** Only a form that shows the collection field asks for the collections. */
  private readonly topicList = httpResource(
    () => (this.shows('topic') ? topicsUrl() : undefined),
    {
      parse: (body) => topicListSchema.parse(body),
    },
  );
  protected readonly topics = computed(() =>
    this.topicList.hasValue() ? this.topicList.value().items : [],
  );
  protected readonly views = DEFAULT_VIEWS.map((value) => ({
    value,
    label: VIEW_COPY[value](),
  }));
  protected readonly profiles = RESEARCH_PROFILES.map((value) => ({
    value,
    label: PROFILE_COPY[value].label(),
    help: PROFILE_COPY[value].help(),
  }));
  protected readonly modes = MODE_OPTIONS;
  protected readonly themes = THEMES.map((value) => ({
    value,
    label: THEME_COPY[value](),
  }));

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
