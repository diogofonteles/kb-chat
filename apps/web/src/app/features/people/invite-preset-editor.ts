import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
} from '@angular/core';
import {
  APP_AI_ASSIGNMENTS,
  DEFAULT_VIEWS,
  FEATURES,
  MAX_DAILY_RESEARCHES,
  MAX_MONTHLY_CAP_USD,
  RESEARCH_PROFILES,
  THEMES,
  isLentSubscription,
  type AppAi,
  type Feature,
  type InvitePreset,
  type Topic,
} from '@kb-chat/contracts';
import { assignmentLabel } from '@features/house-ai/app-ai-labels.js';
import { parseCap, parseDaily } from '@features/house-ai/number-fields.js';
import { PROFILE_COPY } from '@features/research/profile-copy.js';
import { THEME_COPY, VIEW_COPY } from '@features/settings/provider-copy.js';
import { FEATURE_LABELS } from './feature-labels.js';

type PresetAppAi = InvitePreset['ai']['appAi'];
type InitialPreferences = InvitePreset['preferences'];

/** A preset never lends a subscription (KBC-028 BR-2): only these are offered. */
const PRESET_APP_AIS = APP_AI_ASSIGNMENTS.filter(
  (id): id is PresetAppAi => !isLentSubscription(id),
);

const toggled = <T>(values: readonly T[], value: T, on: boolean): T[] =>
  on ? [...new Set([...values, value])] : values.filter((v) => v !== value);

/** One of `allowed`, or undefined ("Sem preferência"). */
function pick<T extends string>(
  allowed: readonly T[],
  value: string,
): T | undefined {
  return allowed.find((option) => option === value);
}

let nextId = 0;

/**
 * Everything an invitation sets up (KBC-028, screens.md T9): role, collections, features, the
 * app AI and its limits, and the initial preferences. Presentational: each change goes up as
 * the whole preset; the invitation or the profile keeps it.
 */
@Component({
  selector: 'app-invite-preset-editor',
  templateUrl: './invite-preset-editor.html',
  styleUrls: ['./person-editor.css', './invite-preset-editor.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class InvitePresetEditor {
  readonly preset = input.required<InvitePreset>();
  readonly topics = input.required<readonly Topic[]>();
  /** The house default app AI (KBC-022), named in the "Padrão" option. */
  readonly defaultAppAi = input<AppAi | null>(null);
  readonly busy = input(false);
  readonly changed = output<InvitePreset>();
  /** True while a typed number is not kept: the invitation or profile waits (design D4). */
  readonly invalidChange = output<boolean>();

  protected readonly uid = `preset-${nextId++}`;
  protected readonly isMaster = computed(() => this.preset().role === 'master');
  protected readonly collections = computed(() =>
    this.topics().map((topic) => ({
      ...topic,
      checked: this.isMaster() || this.preset().topics.includes(topic.slug),
    })),
  );
  protected readonly features = computed(() =>
    FEATURES.map((id) => ({
      id,
      label: FEATURE_LABELS[id](),
      checked: this.isMaster() || this.preset().features.includes(id),
    })),
  );
  protected readonly appAis = computed(() =>
    PRESET_APP_AIS.map((id) => ({
      id,
      label: assignmentLabel(id, this.defaultAppAi()),
    })),
  );
  /** The default collection is one of those granted (BR-4); a master sees them all. */
  protected readonly defaultTopics = computed(() =>
    this.collections().filter((topic) => topic.checked),
  );
  protected readonly views = DEFAULT_VIEWS.map((id) => ({
    id,
    label: VIEW_COPY[id](),
  }));
  protected readonly profiles = RESEARCH_PROFILES.map((id) => ({
    id,
    label: PROFILE_COPY[id].label(),
  }));
  protected readonly themes = THEMES.map((id) => ({
    id,
    label: THEME_COPY[id](),
  }));
  protected readonly maxDaily = MAX_DAILY_RESEARCHES;
  protected readonly maxCap = MAX_MONTHLY_CAP_USD;
  /** Why a typed number was not kept; shown on its field (MA-23). */
  protected readonly dailyError = signal<string | null>(null);
  protected readonly capError = signal<string | null>(null);
  /** With "Nenhuma", the limits of the app AI have nothing to apply to. */
  protected readonly noAppAi = computed(
    () => this.preset().ai.appAi === 'none',
  );

  protected setMaster(on: boolean): void {
    const { topics, preferences } = this.preset();
    // Back to member, the default collection must be one of theirs (BR-4).
    const keeps =
      on ||
      preferences.defaultTopic === undefined ||
      topics.includes(preferences.defaultTopic);
    this.emit(
      { role: on ? 'master' : 'member' },
      keeps ? {} : { defaultTopic: undefined },
    );
  }

  protected toggleTopic(slug: string, on: boolean): void {
    const topics = toggled(this.preset().topics, slug, on);
    const { defaultTopic } = this.preset().preferences;
    // A collection taken away is no longer the default one (BR-4).
    const keeps = defaultTopic === undefined || topics.includes(defaultTopic);
    this.emit({ topics }, keeps ? {} : { defaultTopic: undefined });
  }

  protected toggleFeature(feature: Feature, on: boolean): void {
    this.emit({ features: toggled(this.preset().features, feature, on) });
  }

  protected chooseAppAi(value: string): void {
    const appAi = pick(PRESET_APP_AIS, value);
    if (appAi) this.emitAi({ appAi });
  }

  protected setEnforced(enforced: boolean): void {
    this.emitAi({ enforced });
  }

  /** Blank: the house default; otherwise a whole number of researches a day. */
  protected setDaily(value: string): void {
    const parsed = parseDaily(value, true);
    this.dailyError.set(parsed.ok ? null : parsed.error);
    this.reportValidity();
    if (parsed.ok) this.emitAi({ dailyResearches: parsed.value });
  }

  protected setPaid(enabled: boolean): void {
    if (!enabled && this.capError()) {
      this.capError.set(null);
      this.reportValidity();
    }
    const { monthlyCapUsd } = this.preset().ai.paidFallback;
    this.emitAi({ paidFallback: { enabled, monthlyCapUsd } });
  }

  protected setCap(value: string): void {
    const parsed = parseCap(value);
    this.capError.set(parsed.ok ? null : parsed.error);
    this.reportValidity();
    if (!parsed.ok) return;
    const { enabled } = this.preset().ai.paidFallback;
    this.emitAi({ paidFallback: { enabled, monthlyCapUsd: parsed.value } });
  }

  protected setDefaultTopic(value: string): void {
    this.emit({}, { defaultTopic: value || undefined });
  }

  protected setDefaultView(value: string): void {
    this.emit({}, { defaultView: pick(DEFAULT_VIEWS, value) });
  }

  protected setResearchProfile(value: string): void {
    this.emit({}, { researchProfile: pick(RESEARCH_PROFILES, value) });
  }

  protected setTheme(value: string): void {
    this.emit({}, { theme: pick(THEMES, value) });
  }

  private reportValidity(): void {
    this.invalidChange.emit(
      this.dailyError() !== null || this.capError() !== null,
    );
  }

  private emitAi(patch: Partial<InvitePreset['ai']>): void {
    this.emit({ ai: { ...this.preset().ai, ...patch } });
  }

  /** "Sem preferência" drops the key: the person's Settings keep their own default. */
  private emit(
    patch: Partial<InvitePreset>,
    preferences: Partial<InitialPreferences> = {},
  ): void {
    const merged = { ...this.preset().preferences, ...preferences };
    const kept = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    ) as InitialPreferences;
    this.changed.emit({ ...this.preset(), ...patch, preferences: kept });
  }
}
