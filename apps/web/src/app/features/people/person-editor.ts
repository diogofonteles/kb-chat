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
  FEATURES,
  type Feature,
  type Person,
  type PersonUpdate,
  type Topic,
} from '@kb-chat/contracts';
import { FEATURE_LABELS } from './feature-labels.js';

const toggled = <T>(values: readonly T[], value: T, on: boolean): T[] =>
  on ? [...new Set([...values, value])] : values.filter((v) => v !== value);

/**
 * One person's collections, features and role (KBC-010 FR-3). Presentational: each change
 * goes up as a patch and the page saves it, as Preferências do.
 */
@Component({
  selector: 'app-person-editor',
  templateUrl: './person-editor.html',
  styleUrl: './person-editor.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PersonEditor {
  private readonly injector = inject(Injector);
  readonly person = input.required<Person>();
  readonly topics = input.required<readonly Topic[]>();
  readonly busy = input(false);
  readonly changed = output<PersonUpdate>();
  readonly revoked = output();

  private readonly confirmButton =
    viewChild<ElementRef<HTMLButtonElement>>('confirmButton');
  private readonly revokeButton =
    viewChild<ElementRef<HTMLButtonElement>>('revokeButton');

  protected readonly confirming = signal(false);
  protected readonly isMaster = computed(() => this.person().role === 'master');
  protected readonly features = computed(() =>
    FEATURES.map((id) => ({
      id,
      label: FEATURE_LABELS[id](),
      checked: this.isMaster() || this.person().features.includes(id),
    })),
  );
  protected readonly collections = computed(() =>
    this.topics().map((topic) => ({
      ...topic,
      checked: this.isMaster() || this.person().topics.includes(topic.slug),
    })),
  );

  protected toggleTopic(slug: string, on: boolean): void {
    this.changed.emit({ topics: toggled(this.person().topics, slug, on) });
  }

  protected toggleFeature(feature: Feature, on: boolean): void {
    this.changed.emit({
      features: toggled(this.person().features, feature, on),
    });
  }

  protected toggleMaster(): void {
    this.changed.emit({ role: this.isMaster() ? 'member' : 'master' });
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
