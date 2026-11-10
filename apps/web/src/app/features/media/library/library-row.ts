import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  listeningStateOf,
  type LibraryItem,
  type PreparationStep,
} from '@kb-chat/contracts';
import { formatDuration } from '@kb-chat/player-core';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import { editDetailsLabel } from '../edit-labels.js';
import { MediaLevelBadge } from '../media-level-badge.js';
import { statusTextOf } from '../media-labels.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { PreparationEntry } from '../preparation/preparation-entry.js';
import { percentOf, resumeTextOf, stateTextOf } from './library-labels.js';

/** What the row's "⋯" can do. */
export type RowAction = 'mark-played' | 'mark-unplayed' | 'edit' | 'remove';

/**
 * One media in "Todas" as a list (screens.md T16): the whole row opens the player, ▶ plays
 * at once, the box selects it, and the ⋯ marks it heard or not (masters also remove).
 */
@Component({
  // The host is the list item (role), so the list holds only items (axe "list").
  selector: 'app-library-row',
  imports: [
    RouterLink,
    AuthorshipBadge,
    MediaLevelBadge,
    MenuButton,
    PreparationEntry,
  ],
  templateUrl: './library-row.html',
  styleUrl: './library-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'row',
    role: 'listitem',
    '[class.selected]': 'selected()',
    '[class.failed]': "item().status === 'failed'",
  },
})
export class LibraryRow {
  readonly item = input.required<LibraryItem>();
  /** The collection's name, as the person knows it. */
  readonly topicTitle = input('');
  readonly selected = input(false);
  readonly playing = input(false);
  readonly master = input(false);
  /** Where this media's preparation stopped (KBC-072 FR-6). */
  readonly paused = input<PreparationStep | null>(null);
  readonly played = output();
  readonly selectedChange = output<boolean>();
  readonly acted = output<RowAction>();
  readonly retried = output();

  protected readonly ready = computed(() => this.item().status === 'ready');
  protected readonly duration = computed(() => {
    const ms = this.item().durationMs;
    return ms === null ? '' : formatDuration(ms);
  });
  protected readonly state = computed(() => stateTextOf(this.item()));
  protected readonly resume = computed(() => resumeTextOf(this.item()));
  protected readonly percent = computed(() => percentOf(this.item()));
  /** "Na fila", "Convertendo… 40%", "Falhou: …" for a media not ready (BR-2). */
  protected readonly status = computed(() =>
    this.ready() ? '' : statusTextOf(this.item()),
  );
  protected readonly playLabel = computed(() =>
    this.playing()
      ? $localize`:@@library.pause:Pausar ${this.item().title}:title:`
      : $localize`:@@library.play:Tocar ${this.item().title}:title:`,
  );
  protected readonly selectLabel = computed(
    () => $localize`:@@library.select:Selecionar ${this.item().title}:title:`,
  );
  protected readonly menuLabel = computed(
    () =>
      $localize`:@@media.moreActions:Mais ações para ${this.item().title}:title:`,
  );
  protected readonly options = computed<readonly MenuOption[]>(() => {
    const options: MenuOption[] = [];
    if (this.ready())
      options.push(
        listeningStateOf(this.item()) === 'heard'
          ? {
              id: 'mark-unplayed',
              label: $localize`:@@library.markUnplayed:Marcar como não ouvida`,
            }
          : {
              id: 'mark-played',
              label: $localize`:@@library.markPlayed:Marcar como ouvida`,
            },
      );
    if (this.item().canEdit)
      options.push({ id: 'edit', label: editDetailsLabel() });
    if (this.master())
      options.push({
        id: 'remove',
        label: $localize`:@@media.remove:Remover`,
        danger: true,
      });
    return options;
  });

  protected choose(id: string): void {
    const action = ACTIONS.find((one) => one === id);
    if (action) this.acted.emit(action);
  }

  protected toggleSelected(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.selectedChange.emit(event.target.checked);
  }
}

const ACTIONS: readonly RowAction[] = [
  'mark-played',
  'mark-unplayed',
  'edit',
  'remove',
];
