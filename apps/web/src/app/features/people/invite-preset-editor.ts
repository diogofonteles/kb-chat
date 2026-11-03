import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
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
  type AppAiAssignment,
  type Feature,
  type InvitationPreset,
  type LentSubscription,
  type Topic,
} from '@kb-chat/contracts';
import { assignmentLabel } from '@features/house-ai/app-ai-labels.js';
import { parseCap, parseDaily } from '@features/house-ai/number-fields.js';
import { PROFILE_COPY } from '@features/research/profile-copy.js';
import { THEME_COPY, VIEW_COPY } from '@features/settings/provider-copy.js';
import { collectionChoices, treeTitle } from '@core/topics/topic-tree.js';
import { FEATURE_LABELS } from './feature-labels.js';
import {
  LEND_COPY,
  LEND_NOT_OFFERED,
  NO_LENDING,
  type Lending,
} from './lending.js';

type InitialPreferences = InvitationPreset['preferences'];

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
  readonly preset = input.required<InvitationPreset>();
  readonly topics = input.required<readonly Topic[]>();
  /** The house default app AI (KBC-022), named in the "Padrão" option. */
  readonly defaultAppAi = input<AppAi | null>(null);
  readonly busy = input(false);
  /**
   * The owner's subscriptions this invitation may lend (KBC-031); a profile never gets any,
   * so its editor keeps the default (none).
   */
  readonly lending = input<Lending>(NO_LENDING);
  readonly changed = output<InvitationPreset>();
  /** True while a typed number is not kept: the invitation or profile waits (design D4). */
  readonly invalidChange = output<boolean>();
  /** True while a subscription waits for its terms: the invitation says why it waits. */
  readonly lendPending = output<boolean>();

  private readonly injector = inject(Injector);
  private readonly appAiSelect =
    viewChild<ElementRef<HTMLSelectElement>>('appAiSelect');
  private readonly cancelLendButton =
    viewChild<ElementRef<HTMLButtonElement>>('cancelLendButton');

  protected readonly uid = `preset-${nextId++}`;
  protected readonly isMaster = computed(() => this.preset().role === 'master');
  /** The collections as a tree; a sub-collection comes with its parent (KBC-048 BR-3). */
  protected readonly collections = computed(() =>
    collectionChoices(this.topics(), this.preset().topics, this.isMaster()),
  );
  protected readonly features = computed(() =>
    FEATURES.map((id) => ({
      id,
      label: FEATURE_LABELS[id](),
      checked: this.isMaster() || this.preset().features.includes(id),
    })),
  );
  /** The owner's subscriptions join while each can be lent now (KBC-031 BR-4). */
  protected readonly appAis = computed(() =>
    APP_AI_ASSIGNMENTS.filter((id) => this.offered(id)).map((id) => ({
      id,
      label: assignmentLabel(id, this.defaultAppAi()),
    })),
  );
  /** Lending waits for the terms of that subscription (KBC-024 BR-2, KBC-031 BR-2). */
  protected readonly confirmingLend = signal<LentSubscription | null>(null);
  protected readonly lendCopy = computed(() => {
    const kind = this.confirmingLend();
    return kind ? LEND_COPY[kind] : null;
  });
  protected readonly canLend = computed(() => this.lending().canLend);
  /** The choice the field shows: the subscription waiting for its terms, else the preset's. */
  protected readonly shownAppAi = computed(
    () => this.confirmingLend() ?? this.preset().ai.appAi,
  );
  /** Why the owner does not see a subscription now (KBC-031, design R1-5). */
  protected readonly notOffered = computed(() => {
    if (!this.lending().canLend) return [];
    return (['claude-subscription', 'chatgpt-subscription'] as const)
      .filter((kind) => !this.offered(kind))
      .map((kind) => ({
        kind,
        id: `${this.uid}-not-offered-${kind}`,
        text: LEND_NOT_OFFERED[kind](),
      }));
  });
  /** The field is described by its hint and by why a subscription is missing (NG-30). */
  protected readonly appAiDescribedBy = computed(() =>
    [`${this.uid}-ai-hint`, ...this.notOffered().map((note) => note.id)].join(
      ' ',
    ),
  );
  /** Which subscription's terms were confirmed for this invitation, said in a live region. */
  protected readonly confirmedCopy = computed(() => {
    const { appAi, subscriptionTermsAccepted } = this.preset().ai;
    return isLentSubscription(appAi) && subscriptionTermsAccepted === true
      ? LEND_COPY[appAi].confirmedForInvite()
      : null;
  });
  /** The default collection is one of those granted (BR-4); a master sees them all. */
  protected readonly treeTitle = treeTitle;
  protected readonly defaultTopics = computed(() =>
    this.collections().filter((topic) => topic.checked),
  );
  /** With no collection checked, the field says why it offers only "Sem preferência" (KBC-033). */
  protected readonly needsCollection = computed(
    () => this.topics().length > 0 && this.defaultTopics().length === 0,
  );
  protected readonly defaultTopicDescribedBy = computed(() =>
    this.needsCollection() ? `${this.uid}-default-topic-hint` : null,
  );
  /** True once the master picks in "Acervo padrão": the editor never picks for them again. */
  private readonly defaultChosen = signal(false);
  /** The default collection was dropped with its collection: said in a polite live region. */
  protected readonly defaultCleared = signal(false);
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
    // Back to member, the default collection must be one of theirs (BR-4).
    this.emit(
      { role: on ? 'master' : 'member' },
      on ? {} : this.defaultFor(this.preset().topics),
    );
  }

  protected toggleTopic(slug: string, on: boolean): void {
    const topics = toggled(this.preset().topics, slug, on);
    this.emit({ topics }, this.defaultFor(topics));
  }

  /**
   * The default collection once the granted ones change (KBC-033): a collection taken away is
   * no longer the default (BR-4), and says so; the only one granted becomes the default while
   * the master has not picked one.
   */
  private defaultFor(topics: readonly string[]): Partial<InitialPreferences> {
    const { defaultTopic } = this.preset().preferences;
    if (defaultTopic !== undefined && !topics.includes(defaultTopic)) {
      this.defaultCleared.set(true);
      return { defaultTopic: undefined };
    }
    const [only] = topics;
    if (
      defaultTopic === undefined &&
      !this.defaultChosen() &&
      topics.length === 1
    ) {
      this.defaultCleared.set(false);
      return { defaultTopic: only };
    }
    return {};
  }

  protected toggleFeature(feature: Feature, on: boolean): void {
    this.emit({ features: toggled(this.preset().features, feature, on) });
  }

  private offered(id: AppAiAssignment): boolean {
    if (!isLentSubscription(id) || this.preset().ai.appAi === id) return true;
    const { canLend, lendable } = this.lending();
    return canLend && lendable[id];
  }

  protected chooseAppAi(value: string): void {
    const appAi = pick(APP_AI_ASSIGNMENTS, value);
    if (!appAi || !this.offered(appAi)) return;
    if (isLentSubscription(appAi)) {
      // The confirmation opens with focus on the safe choice (WCAG 2.4.3, design D5).
      this.confirmingLend.set(appAi);
      this.reportValidity();
      this.focusAfterRender(() => this.cancelLendButton());
      return;
    }
    this.confirmingLend.set(null);
    // Without an app AI the limits are off: a pending bad number no longer holds anything.
    if (appAi === 'none') {
      this.dailyError.set(null);
      this.capError.set(null);
    }
    this.reportValidity();
    // Another choice never carries the terms confirmed for a subscription.
    this.emitAi({ appAi, subscriptionTermsAccepted: undefined });
  }

  protected lend(): void {
    const kind = this.confirmingLend();
    if (!kind) return;
    this.confirmingLend.set(null);
    this.reportValidity();
    this.emitAi({ appAi: kind, subscriptionTermsAccepted: true });
    this.focusAfterRender(() => this.appAiSelect());
  }

  /** Back to the preset's choice, with focus on the field. */
  protected cancelLend(): void {
    this.confirmingLend.set(null);
    this.reportValidity();
    this.focusAfterRender(() => this.appAiSelect());
  }

  private focusAfterRender(
    target: () => ElementRef<HTMLElement> | undefined,
  ): void {
    afterNextRender(() => target()?.nativeElement.focus(), {
      injector: this.injector,
    });
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
    this.defaultChosen.set(true);
    this.defaultCleared.set(false);
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

  /** A bad number or a lending not yet confirmed holds the invitation (design D4). */
  private reportValidity(): void {
    const pending = this.confirmingLend() !== null;
    this.invalidChange.emit(
      this.dailyError() !== null || this.capError() !== null || pending,
    );
    this.lendPending.emit(pending);
  }

  /** The terms flag goes up only while it is set: another AI never carries it. */
  private emitAi(patch: Partial<InvitationPreset['ai']>): void {
    const { subscriptionTermsAccepted, ...ai } = {
      ...this.preset().ai,
      ...patch,
    };
    this.emit({
      ai: subscriptionTermsAccepted ? { ...ai, subscriptionTermsAccepted } : ai,
    });
  }

  /** "Sem preferência" drops the key: the person's Settings keep their own default. */
  private emit(
    patch: Partial<InvitationPreset>,
    preferences: Partial<InitialPreferences> = {},
  ): void {
    const merged = { ...this.preset().preferences, ...preferences };
    const kept = Object.fromEntries(
      Object.entries(merged).filter(([, value]) => value !== undefined),
    ) as InitialPreferences;
    this.changed.emit({ ...this.preset(), ...patch, preferences: kept });
  }
}
