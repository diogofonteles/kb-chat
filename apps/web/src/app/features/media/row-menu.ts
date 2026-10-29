import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { MenuButton, type MenuOption } from './menu-button.js';

/** The "⋯" menu of a media row (T14): actions that should not shout from every row. */
@Component({
  selector: 'app-row-menu',
  imports: [MenuButton],
  template: `
    <app-menu-button
      [label]="label()"
      [options]="options"
      (chosen)="removeChosen.emit()"
    >
      <span aria-hidden="true">⋯</span>
    </app-menu-button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RowMenu {
  readonly label = input.required<string>();
  readonly removeChosen = output();

  protected readonly options: readonly MenuOption[] = [
    {
      id: 'remove',
      label: $localize`:@@media.remove:Remover`,
      danger: true,
    },
  ];
}
