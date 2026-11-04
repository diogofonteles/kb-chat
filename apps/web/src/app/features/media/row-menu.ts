import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { editDetailsLabel } from './edit-labels.js';
import { MenuButton, type MenuOption } from './menu-button.js';

/** The "⋯" menu of a media row (T14): actions that should not shout from every row. */
@Component({
  selector: 'app-row-menu',
  imports: [MenuButton],
  template: `
    <app-menu-button
      [label]="label()"
      [options]="options()"
      (chosen)="choose($event)"
    >
      <span aria-hidden="true">⋯</span>
    </app-menu-button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RowMenu {
  readonly label = input.required<string>();
  /** "Editar informações" (KBC-050 FR-2): who sent it or a master. */
  readonly canEdit = input(false);
  /** "Remover": masters. */
  readonly canRemove = input(true);
  readonly editChosen = output();
  readonly removeChosen = output();

  protected readonly options = computed<readonly MenuOption[]>(() => [
    ...(this.canEdit() ? [{ id: 'edit', label: editDetailsLabel() }] : []),
    ...(this.canRemove()
      ? [
          {
            id: 'remove',
            label: $localize`:@@media.remove:Remover`,
            danger: true,
          },
        ]
      : []),
  ]);

  protected choose(id: string): void {
    if (id === 'edit') this.editChosen.emit();
    else this.removeChosen.emit();
  }
}
