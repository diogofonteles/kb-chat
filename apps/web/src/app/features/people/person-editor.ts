import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
  signal,
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
  readonly person = input.required<Person>();
  readonly topics = input.required<readonly Topic[]>();
  readonly busy = input(false);
  readonly changed = output<PersonUpdate>();
  readonly revoked = output();

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

  protected confirmRevoke(): void {
    this.confirming.set(false);
    this.revoked.emit();
  }
}
