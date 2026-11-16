import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * A v2 settings row (v2 · Componentes › Linha de configuração): label and description on
 * the left, the control (projected) on the right; stacked on a phone. `for` ties the label
 * to the control's id.
 */
@Component({
  selector: 'ui-setting-row',
  template: `
    <div class="ui-setting__text">
      @if (for()) {
        <label class="ui-setting__label" [attr.for]="for()">{{
          label()
        }}</label>
      } @else {
        <span class="ui-setting__label">{{ label() }}</span>
      }
      @if (description()) {
        <span class="ui-setting__description" [attr.id]="descriptionId()">{{
          description()
        }}</span>
      }
    </div>
    <div class="ui-setting__control"><ng-content /></div>
  `,
  host: { class: 'ui-setting' },
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiSettingRow {
  readonly label = input.required<string>();
  readonly description = input('');
  readonly for = input('');
  /** The description's id, for the control's aria-describedby. */
  readonly descriptionId = input<string | null>(null);
}
