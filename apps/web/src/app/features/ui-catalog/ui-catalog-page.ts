import {
  ChangeDetectionStrategy,
  Component,
  signal,
  viewChild,
} from '@angular/core';
import {
  UiAvatar,
  UiBanner,
  UiButton,
  UiCard,
  UiChip,
  UiChoiceCard,
  UiCodeInput,
  UiCover,
  UiDialog,
  UiEmptyState,
  UiField,
  UiIcon,
  UiIconButton,
  UiLibraryItem,
  UiLogo,
  UiMenu,
  UiMenuItem,
  UiPill,
  UiProgress,
  UiSettingRow,
  UiSheet,
} from '@ui/index.js';

/**
 * The catalog of the v2 base components (KBC-124 FR-3, AC-8), the code twin of the Figma page
 * "v2 · Componentes": every set with its variants, focus and disabled states. Development
 * only (the route matches with isDevMode), so the E2E can run axe over each component.
 */
@Component({
  selector: 'app-ui-catalog-page',
  imports: [
    UiAvatar,
    UiBanner,
    UiButton,
    UiCard,
    UiChip,
    UiChoiceCard,
    UiCodeInput,
    UiCover,
    UiDialog,
    UiEmptyState,
    UiField,
    UiIcon,
    UiIconButton,
    UiLibraryItem,
    UiLogo,
    UiMenu,
    UiMenuItem,
    UiPill,
    UiProgress,
    UiSettingRow,
    UiSheet,
  ],
  templateUrl: './ui-catalog-page.html',
  styleUrl: './ui-catalog-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class UiCatalogPage {
  protected readonly code = signal('481');
  protected readonly chip = signal('Tudo');
  protected readonly toggled = signal(true);
  protected readonly chips = ['Tudo', 'Documentos', 'Pesquisa com IA'];
  private readonly dialog = viewChild.required(UiDialog);
  private readonly sheet = viewChild.required(UiSheet);

  protected openDialog(): void {
    this.dialog().open();
  }

  protected openSheet(): void {
    this.sheet().open();
  }
}
