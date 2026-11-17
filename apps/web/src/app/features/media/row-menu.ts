import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { editDetailsLabel } from './edit-labels.js';
import { MenuButton, type MenuOption } from './menu-button.js';

/**
 * The "⋯" menu of a media row (T14; v2 media-list-menu): "Tocar agora", then "Editar
 * informações" and "Copiar link" ("Compartilhar" on a phone, where the row plays on a tap),
 * then "Remover" for masters, set apart.
 */
@Component({
  selector: 'app-row-menu',
  imports: [MenuButton],
  template: `
    <app-menu-button
      [label]="label()"
      [options]="options()"
      [sheetTitle]="sheetTitle()"
      [sheetMeta]="sheetMeta()"
      (chosen)="choose($event)"
    >
      <span aria-hidden="true">⋯</span>
    </app-menu-button>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RowMenu {
  readonly label = input.required<string>();
  /** "Tocar agora" and the link: a ready media. */
  readonly canPlay = input(false);
  /** "Editar informações" (KBC-050 FR-2): who sent it or a master. */
  readonly canEdit = input(false);
  /** "Remover": masters. */
  readonly canRemove = input(true);
  /** A phone: the row itself plays, the link goes through the system's sheet. */
  readonly phone = input(false);
  /** The phone's sheet names the audio over the items (media-list-menu@mobile). */
  readonly sheetTitle = input('');
  readonly sheetMeta = input('');
  readonly playChosen = output();
  readonly linkChosen = output();
  readonly editChosen = output();
  readonly removeChosen = output();

  protected readonly options = computed<readonly MenuOption[]>(() => {
    const phone = this.phone();
    const options: MenuOption[] = [];
    if (this.canPlay() && !phone)
      options.push({
        id: 'play',
        label: $localize`:@@library.playNow:Tocar agora`,
        icon: 'play',
      });
    const second = options.length > 0;
    if (this.canEdit())
      options.push({
        id: 'edit',
        label: editDetailsLabel(),
        icon: 'edit',
        divider: second,
      });
    if (this.canPlay())
      options.push(linkOption(phone, second && !this.canEdit()));
    if (this.canRemove())
      options.push({
        id: 'remove',
        label: $localize`:@@media.remove:Remover`,
        icon: 'trash',
        danger: true,
      });
    return options;
  });

  protected choose(id: string): void {
    if (id === 'play') this.playChosen.emit();
    else if (id === 'link') this.linkChosen.emit();
    else if (id === 'edit') this.editChosen.emit();
    else this.removeChosen.emit();
  }
}

/** "Copiar link", or "Compartilhar" through the phone's own sheet. */
function linkOption(phone: boolean, divider: boolean): MenuOption {
  return {
    id: 'link',
    label: phone
      ? $localize`:@@library.share:Compartilhar`
      : $localize`:@@library.copyLink:Copiar link`,
    icon: phone ? 'share' : 'link',
    divider,
  };
}
