import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  model,
  viewChildren,
} from '@angular/core';

const LENGTH = 6;
const onlyDigits = (text: string): string => text.replace(/\D/g, '');

/**
 * The one-time code in 6 digit boxes (v2 · Auth, KBC-124 FR-4, AC-4): typing moves to the
 * next box, pasting "481920" (or "481 920") fills every box, Backspace in an empty box goes
 * back to the one before, the arrows move. `value` is the digits typed so far.
 */
@Component({
  selector: 'ui-code-input',
  template: `
    @for (index of boxes; track index) {
      <input
        #box
        class="ui-code__digit"
        [class.ui-code__digit--current]="index === current()"
        type="text"
        inputmode="numeric"
        [attr.autocomplete]="index === 0 ? 'one-time-code' : 'off'"
        [attr.aria-label]="digitLabel(index)"
        [attr.aria-invalid]="invalid() ? 'true' : null"
        [attr.aria-describedby]="describedBy()"
        [disabled]="disabled()"
        [value]="value().charAt(index)"
        (input)="typed(index, $event)"
        (keydown)="keydown(index, $event)"
        (paste)="pasted(index, $event)"
        (focus)="select($event)"
      />
    }
  `,
  host: {
    class: 'ui-code',
    role: 'group',
    '[attr.aria-labelledby]': 'labelledBy()',
  },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiCodeInput {
  readonly value = model('');
  /** The id of the visible "Código" label. */
  readonly labelledBy = input.required<string>();
  readonly describedBy = input<string | null>(null);
  readonly invalid = input(false);
  readonly disabled = input(false);
  protected readonly boxes = Array.from({ length: LENGTH }, (_, i) => i);
  /** The box the next digit goes to (outlined, as in the frame). */
  protected readonly current = computed(() =>
    Math.min(this.value().length, LENGTH - 1),
  );
  private readonly inputs = viewChildren<ElementRef<HTMLInputElement>>('box');

  /** Focus the first empty box (or the last). */
  focus(): void {
    this.at(this.current())?.focus();
  }

  protected digitLabel(index: number): string {
    return $localize`:@@ui.code.digit:Dígito ${index + 1}:n: de ${LENGTH}:total:`;
  }

  protected typed(index: number, event: Event): void {
    const field = event.target as HTMLInputElement;
    const digits = onlyDigits(field.value);
    if (!digits) {
      field.value = this.value().charAt(index);
      return;
    }
    this.fill(index, digits);
  }

  protected pasted(index: number, event: ClipboardEvent): void {
    const digits = onlyDigits(event.clipboardData?.getData('text') ?? '');
    event.preventDefault();
    if (digits) this.fill(digits.length >= LENGTH ? 0 : index, digits);
  }

  protected keydown(index: number, event: KeyboardEvent): void {
    if (event.key === 'Backspace') this.erase(index, event);
    else if (event.key === 'ArrowLeft') this.at(index - 1)?.focus();
    else if (event.key === 'ArrowRight') this.at(index + 1)?.focus();
  }

  protected select(event: FocusEvent): void {
    (event.target as HTMLInputElement).select();
  }

  /** Backspace clears this box, or in an empty one goes back and clears the previous. */
  private erase(index: number, event: KeyboardEvent): void {
    event.preventDefault();
    const value = this.value();
    const target = value.charAt(index) ? index : index - 1;
    if (target < 0) return;
    this.value.set(value.slice(0, target));
    this.at(target)?.focus();
  }

  /** Digits from `index` on; the code is always the digits before the first gap. */
  private fill(index: number, digits: string): void {
    const start = Math.min(index, this.value().length);
    const next = (this.value().slice(0, start) + digits).slice(0, LENGTH);
    this.value.set(next);
    this.at(Math.min(next.length, LENGTH - 1))?.focus();
  }

  private at(index: number): HTMLInputElement | undefined {
    return this.inputs()[index]?.nativeElement;
  }
}
