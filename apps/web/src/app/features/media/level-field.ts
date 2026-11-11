import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  input,
  model,
  output,
  viewChild,
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
  /** Asked again after a failure: the button stays, busy, and keeps the focus. */
  readonly retrying = input(false);
  readonly disabled = input(false);
  /** The level id chosen; null: none yet. */
  readonly level = model<string | null>(null);
  /** "Carregar níveis de novo" after the levels could not be had (MA-26). */
  readonly retried = output();

  private readonly retryButton =
    viewChild<ElementRef<HTMLButtonElement>>('retryButton');
  private readonly choicesBox =
    viewChild<ElementRef<HTMLElement>>('choicesBox');
  /** A retry was asked from here: once it ends, the focus goes on in the field (MA-29). */
  private refocus = false;
  /** The retry asked from here was seen under way (so its failure ends what it owed). */
  private retryUnderWay = false;
  /** The way out was asked to take the focus before it was drawn. */
  private retryFocusAsked = false;

  private readonly id = `level-${nextId++}`;
  protected readonly name = this.id;
  protected readonly helpId = `${this.id}-help`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly selectId = `${this.id}-select`;
  protected readonly legendId = `${this.id}-legend`;
  protected readonly asRadios = computed(
    () => this.choices().length <= RADIOS_MAX,
  );
  protected readonly describedBy = computed(() =>
    this.invalid() ? `${this.helpId} ${this.errorId}` : this.helpId,
  );

  constructor() {
    // DOM work only: after a retry that brought the levels, the focus goes to the choices.
    // A retry that failed again keeps the same button, focus and all.
    afterRenderEffect(() => {
      const box = this.choicesBox()?.nativeElement;
      const button = this.retryButton()?.nativeElement;
      // A retry that failed again keeps its button and its focus: nothing is owed after.
      if (this.retrying()) this.retryUnderWay = true;
      else if (this.failed() && this.retryUnderWay)
        this.refocus = this.retryUnderWay = false;
      if (this.refocus && box) {
        (box.querySelector<HTMLElement>('input, select') ?? box).focus();
        this.refocus = this.retryUnderWay = false;
      }
      if (this.retryFocusAsked && button) {
        button.focus();
        this.retryFocusAsked = false;
      }
    });
  }

  /**
   * The parent's send found the levels missing here: the way out takes the focus, now or as
   * soon as it is drawn (review round 3: a send held for the levels that then failed).
   */
  focusRetry(): void {
    const button = this.retryButton()?.nativeElement;
    if (button) button.focus();
    else this.retryFocusAsked = true;
  }

  protected retry(): void {
    if (this.retrying()) return;
    this.refocus = true;
    this.retried.emit();
  }

  protected choose(id: string): void {
    this.level.set(id === '' ? null : id);
  }

  protected selected(event: Event): void {
    const target = event.target;
    if (target instanceof HTMLSelectElement) this.choose(target.value);
  }
}
