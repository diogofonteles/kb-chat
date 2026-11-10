import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
} from '@angular/core';
import type { LevelChoice } from '@kb-chat/contracts';

/** Up to this many levels the choice is a group of radios; past it, a select (T14). */
const RADIOS_MAX = 6;

let nextId = 0;

/**
 * "Nível" (screens.md T14, KBC-105): who sends or edits an audio in a collection with levels
 * chooses one, with nothing chosen beforehand (SL-28). Only the levels the person may give
 * are offered; the parent says when the missing choice is to be said.
 */
@Component({
  selector: 'app-level-field',
  templateUrl: './level-field.html',
  styleUrl: './level-field.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LevelField {
  readonly choices = input.required<readonly LevelChoice[]>();
  /** "Nível", or "Nível em UDV" when the audio moves to another collection's scale. */
  readonly label = input.required<string>();
  /** The person tried to send without a level: the field says so. */
  readonly invalid = input(false);
  readonly loading = input(false);
  readonly failed = input(false);
  readonly disabled = input(false);
  /** The level id chosen; null: none yet. */
  readonly level = model<string | null>(null);

  private readonly id = `level-${nextId++}`;
  protected readonly name = this.id;
  protected readonly helpId = `${this.id}-help`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly selectId = `${this.id}-select`;
  protected readonly asRadios = computed(
    () => this.choices().length <= RADIOS_MAX,
  );
  protected readonly describedBy = computed(() =>
    this.invalid() ? `${this.helpId} ${this.errorId}` : this.helpId,
  );

  protected choose(id: string): void {
    this.level.set(id === '' ? null : id);
  }

  protected selected(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLSelectElement) this.choose(target.value);
  }
}
