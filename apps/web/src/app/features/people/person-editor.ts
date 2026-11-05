import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  GRANTABLE_FEATURES,
  MASTER_FEATURES,
  MEDIA_DEFAULT_QUOTA_BYTES,
  mediaQuotaSchema,
  type AppAi,
  type Feature,
  type InviteProfile,
  type Person,
  type PersonUpdate,
  type Topic,
} from '@kb-chat/contracts';
import { collectionChoices } from '@core/topics/topic-tree.js';
import { FEATURE_LABELS } from './feature-labels.js';
import { NO_LENDING, type Lending } from './lending.js';
import { PersonAiEditor } from './person-ai-editor.js';

const toggled = <T>(values: readonly T[], value: T, on: boolean): T[] =>
  on ? [...new Set([...values, value])] : values.filter((v) => v !== value);

/** Saving keeps what was checked here; at rest, what was saved. */
interface Saving<T> {
  readonly saved: readonly T[];
  readonly busy: boolean;
}

function whileSaving<T>(
  source: Saving<T>,
  previous?: { readonly value: readonly T[] },
): readonly T[] {
  return source.busy && previous ? previous.value : source.saved;
}

const BYTES_PER_GB = 1024 ** 3;

/** The quota in the field: three decimals reach 1 MB, and hide what a binary GB leaves over. */
const quotaFormat = new Intl.NumberFormat('pt-BR', {
  maximumFractionDigits: 3,
  useGrouping: false,
});

/**
 * One person's collections, features and role (KBC-010 FR-3). Presentational: each change
 * goes up as a patch and the page saves it, as Preferências do.
 */
@Component({
  selector: 'app-person-editor',
  imports: [PersonAiEditor],
  templateUrl: './person-editor.html',
  styleUrl: './person-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonEditor {
  private readonly injector = inject(Injector);
  readonly person = input.required<Person>();
  readonly topics = input.required<readonly Topic[]>();
  readonly busy = input(false);
  /** The house default app AI (KBC-022), named in the person's AI choice. */
  readonly defaultAppAi = input<AppAi | null>(null);
  /** Whether the owner's subscription is offered (KBC-024). */
  readonly lending = input<Lending>(NO_LENDING);
  /** The invitation profiles a master can apply here (KBC-028 FR-4). */
  readonly profiles = input<readonly InviteProfile[]>([]);
  /** The signed-in account may act as this person (KBC-060): shows "Ver como". */
  readonly mayActAs = input(false);
  /** The owner looks: only it grants "Ver como" to a master (BR-1). */
  readonly ownerView = input(false);
  readonly changed = output<PersonUpdate>();
  readonly actAs = output();
  readonly revoked = output();
  /** "Aplicar perfil", once confirmed: the profile's id. */
  readonly profileApplied = output<string>();

  private readonly confirmButton =
    viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private readonly revokeButton =
    viewChild<ElementRef<HTMLButtonElement>>('revokeButton');
  private readonly applyConfirmButton =
    viewChild<ElementRef<HTMLButtonElement>>('applyConfirmButton');
  private readonly applyButton =
    viewChild<ElementRef<HTMLButtonElement>>('applyButton');

  protected readonly confirming = signal(false);
  /** The profile picked in "Aplicar perfil"; the first one until another is chosen. */
  protected readonly chosenProfileId = signal<string | null>(null);
  protected readonly chosenProfile = computed(
    () =>
      this.profiles().find((p) => p.id === this.chosenProfileId()) ??
      this.profiles()[0] ??
      null,
  );
  /** Applying waits for a confirmation on the line (screens.md T9). */
  protected readonly confirmingApply = signal(false);
  /** After applying, focus returns to "Aplicar perfil" once the save is over (WCAG 2.4.3). */
  private refocusApply = false;
  private readonly refocusAfterApply = afterRenderEffect(() => {
    if (this.busy() || !this.refocusApply) return;
    this.refocusApply = false;
    this.applyButton()?.nativeElement.focus();
  });
  protected readonly isMaster = computed(() => this.person().role === 'master');
  /**
   * The collections and features as checked here (KBC-062): while changes save, the boxes
   * stay usable and the next change builds on the last one checked, not on the last one
   * saved; once nothing is saving they show what the server kept.
   */
  private readonly checkedTopics = linkedSignal<
    Saving<string>,
    readonly string[]
  >({
    source: () => ({ saved: this.person().topics, busy: this.busy() }),
    computation: whileSaving,
  });
  private readonly checkedFeatures = linkedSignal<
    Saving<Feature>,
    readonly Feature[]
  >({
    source: () => ({ saved: this.person().features, busy: this.busy() }),
    computation: whileSaving,
  });
  /** A master's own features (ADR 0032) are not offered to a member. */
  protected readonly features = computed(() =>
    (this.isMaster() ? MASTER_FEATURES : GRANTABLE_FEATURES).map((id) => ({
      id,
      label: FEATURE_LABELS[id](),
      checked: this.isMaster() || this.checkedFeatures().includes(id),
    })),
  );
  /** The collections as a tree; a sub-collection comes with its parent (KBC-048 BR-3). */
  protected readonly collections = computed(() =>
    collectionChoices(this.topics(), this.checkedTopics(), this.isMaster()),
  );

  /** Masters may give someone who sends another quota; the owner has none (KBC-035 BR-1). */
  protected readonly hasQuota = computed(
    () =>
      !this.person().isOwner &&
      (this.isMaster() || this.person().features.includes('media-upload')),
  );
  protected readonly quotaGb = computed(() => {
    const bytes = this.person().mediaQuotaBytes ?? null;
    return bytes === null ? '' : quotaFormat.format(bytes / BYTES_PER_GB);
  });
  protected readonly defaultQuotaGb = MEDIA_DEFAULT_QUOTA_BYTES / BYTES_PER_GB;
  protected readonly quotaProblem = signal(false);

  /** Blank goes back to the default; a value the API would refuse is said here. */
  protected changeQuota(typed: string): void {
    const gigabytes = Number(typed.replace(',', '.'));
    const bytes = Math.round(gigabytes * BYTES_PER_GB);
    const valid =
      typed.trim() === '' || mediaQuotaSchema.safeParse(bytes).success;
    this.quotaProblem.set(!valid);
    if (valid)
      this.changed.emit({
        mediaQuotaBytes: typed.trim() === '' ? null : bytes,
      });
  }

  protected toggleTopic(slug: string, on: boolean): void {
    const topics = toggled(this.checkedTopics(), slug, on);
    this.checkedTopics.set(topics);
    this.changed.emit({ topics });
  }

  protected toggleFeature(feature: Feature, on: boolean): void {
    const features = toggled(this.checkedFeatures(), feature, on);
    this.checkedFeatures.set(features);
    this.changed.emit({ features });
  }

  protected toggleMaster(): void {
    this.changed.emit({ role: this.isMaster() ? 'member' : 'master' });
  }

  protected chooseProfile(id: string): void {
    this.chosenProfileId.set(id);
    this.confirmingApply.set(false);
  }

  protected askApply(): void {
    this.confirmingApply.set(true);
    this.focusAfterRender(() => this.applyConfirmButton());
  }

  protected cancelApply(): void {
    this.confirmingApply.set(false);
    this.focusAfterRender(() => this.applyButton());
  }

  protected confirmApply(): void {
    const profile = this.chosenProfile();
    this.confirmingApply.set(false);
    if (!profile) return;
    this.refocusApply = true;
    this.profileApplied.emit(profile.id);
  }

  /** The asked-for button replaces the one that had focus: focus follows it (WCAG 2.4.3). */
  protected askRevoke(): void {
    this.confirming.set(true);
    this.focusAfterRender(() => this.confirmButton());
  }

  protected cancelRevoke(): void {
    this.confirming.set(false);
    this.focusAfterRender(() => this.revokeButton());
  }

  private focusAfterRender(
    target: () => ElementRef<HTMLButtonElement> | undefined,
  ): void {
    afterNextRender(() => target()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  protected confirmRevoke(): void {
    this.confirming.set(false);
    this.revoked.emit();
  }
}
