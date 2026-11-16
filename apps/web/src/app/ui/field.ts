import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { UiIcon } from './icon.js';

/**
 * A v2 form field (v2 · Componentes › Campo): label, the control (projected, with the
 * `ui-input` class), a hint and the error under it with an icon. Ids follow `for`:
 * `<for>-hint` and `<for>-error`, for the control's aria-describedby (fieldDescribedBy).
 */
@Component({
  selector: 'ui-field',
  imports: [UiIcon],
  template: `
    @if (label()) {
      <label class="ui-field__label" [attr.for]="for()">{{ label() }}</label>
    }
    <ng-content />
    @if (error()) {
      <p class="ui-field__error" [attr.id]="for() + '-error'">
        <ui-icon name="warn" [size]="14" />{{ error() }}
      </p>
    }
    @if (hint()) {
      <p class="ui-field__hint" [attr.id]="for() + '-hint'">{{ hint() }}</p>
    }
  `,
  host: { class: 'ui-field', '[class.ui-field--invalid]': '!!error()' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiField {
  readonly label = input('');
  readonly for = input.required<string>();
  readonly hint = input('');
  readonly error = input<string | null>(null);
}

/** The aria-describedby of a field's control: its error first, then its hint. */
export function fieldDescribedBy(
  id: string,
  state: { readonly error?: string | null; readonly hint?: string | null },
): string | null {
  const ids = [
    state.error ? `${id}-error` : '',
    state.hint ? `${id}-hint` : '',
  ].filter(Boolean);
  return ids.length ? ids.join(' ') : null;
}
