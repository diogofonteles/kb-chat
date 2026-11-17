import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import {
  listeningStateOf,
  type LibraryItem,
  type PreparationStep,
} from '@kb-chat/contracts';
import { formatDuration } from '@kb-chat/player-core';
import { UiCover } from '@ui/cover.js';
import { UiIcon } from '@ui/icon.js';
import { UiPill } from '@ui/pill.js';
import { UiProgress } from '@ui/progress.js';
import { editDetailsLabel } from '../edit-labels.js';
import { MediaLevelBadge } from '../media-level-badge.js';
import { statusTextOf } from '../media-labels.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { PreparationEntry } from '../preparation/preparation-entry.js';
import { percentOf, stateTextOf, stoppedAtTextOf } from './library-labels.js';

/** What the row's "⋯" can do. */
export type RowAction =
  | 'play'
  | 'mark-played'
  | 'mark-unplayed'
  | 'select'
  | 'edit'
  | 'copy-link'
  | 'retry'
  | 'remove';

/**
 * One media in "Todas" as a row of the v2 track table (KBC-128): # · cover and title ·
 * collection · status · length · ⋯. The whole row opens the player, ▶ on the cover plays at
 * once (green while it plays), the box selects it, and the ⋯ marks it heard or not, edits
 * (who may) and removes (masters).
 */
@Component({
  // The host is the list item (role), so the list holds only items (axe "list").
  selector: 'app-library-row',
  imports: [
    RouterLink,
    MediaLevelBadge,
    MenuButton,
    PreparationEntry,
    UiCover,
    UiIcon,
    UiPill,
    UiProgress,
  ],
  templateUrl: './library-row.html',
  styleUrl: './library-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'row',
    role: 'listitem',
    '[class.selected]': 'selected()',
    '[class.failed]': "item().status === 'failed'",
    '[class.playing]': 'playing()',
  },
})
export class LibraryRow {
  readonly item = input.required<LibraryItem>();
  /** The collection's name, as the person knows it. */
  readonly topicTitle = input('');
  /** Its place in the list (the # column); 0 leaves it out. */
  readonly position = input(0);
  readonly selected = input(false);
  readonly playing = input(false);
  readonly master = input(false);
  /** The phone's row (media-library@mobile): its ⋯ starts a selection, "Compartilhar". */
  readonly phone = input(false);
  /** Where this media's preparation stopped (KBC-072 FR-6). */
  readonly paused = input<PreparationStep | null>(null);
  readonly played = output();
  readonly selectedChange = output<boolean>();
  readonly acted = output<RowAction>();

  /** The author by name, "Outros autores" with none (media-library: plain, muted). */
  protected readonly authorName = computed(
    () =>
      this.item().author?.name ??
      $localize`:@@authorship.others:Outros autores`,
  );
  protected readonly ready = computed(() => this.item().status === 'ready');
  protected readonly duration = computed(() => {
    const ms = this.item().durationMs;
    return ms === null ? '' : formatDuration(ms);
  });
  protected readonly state = computed(() => stateTextOf(this.item()));
  protected readonly resume = computed(() => stoppedAtTextOf(this.item()));
  protected readonly percent = computed(() => percentOf(this.item()));
  /** "Na fila", "Convertendo… 40%", "Falhou: …" for a media not ready (BR-2). */
  protected readonly status = computed(() =>
    this.ready() ? '' : statusTextOf(this.item()),
  );
  /** The table's pill says it in a word (media-library: "Falhou"); the reason follows. */
  protected readonly statusWord = computed(() =>
    this.item().status === 'failed'
      ? $localize`:@@media.status.failedWord:Falhou`
      : this.status(),
  );
  protected readonly statusRest = computed(() =>
    this.status().slice(this.statusWord().length),
  );
  protected readonly playLabel = computed(() =>
    this.playing()
      ? $localize`:@@library.pause:Pausar ${this.item().title}:title:`
      : $localize`:@@library.play:Tocar ${this.item().title}:title:`,
  );
  protected readonly selectLabel = computed(
    () => $localize`:@@library.select:Selecionar ${this.item().title}:title:`,
  );
  /** The phone's sheet under the title: "Irmã Helena Prado · Alquimia Prática" (mSheetHead). */
  protected readonly sheetMeta = computed(() =>
    [
      this.item().author?.name ?? AUTHORSHIP_LABELS['outros-autores'],
      this.topicTitle(),
    ]
      .filter((part) => part !== '')
      .join(' · '),
  );
  protected readonly menuLabel = computed(
    () =>
      $localize`:@@media.moreActions:Mais ações para ${this.item().title}:title:`,
  );
  /**
   * The ⋯ (media-library-row-menu; a sheet on a phone, @mobile): play, mark, select (phone),
   * edit and copy the link, then "Tentar de novo" and "Remover" for masters.
   */
  protected readonly options = computed<readonly MenuOption[]>(() => {
    const ready = this.ready();
    const phone = this.phone();
    const options = listenOptions(this.item(), ready, phone);
    options.push(
      ...shareOptions(this.item(), { ready, phone }, options.length),
    );
    if (this.master()) options.push(...masterOptions(this.item(), options));
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
  'play',
  'mark-played',
  'mark-unplayed',
  'select',
  'edit',
  'copy-link',
  'retry',
  'remove',
];

/** Play (not on a phone: a tap on the cover plays), mark heard or not, select (phone). */
function listenOptions(
  item: LibraryItem,
  ready: boolean,
  phone: boolean,
): MenuOption[] {
  if (!ready) return [];
  const options: MenuOption[] = [];
  if (!phone)
    options.push({
      id: 'play',
      label: $localize`:@@library.playNow:Tocar agora`,
      icon: 'play',
    });
  options.push(markOption(item));
  if (phone)
    options.push({
      id: 'select',
      label: $localize`:@@library.selectRow:Selecionar`,
      icon: 'check',
    });
  return options;
}

/** "Marcar como ouvida", or "não ouvida" once heard. */
function markOption(item: LibraryItem): MenuOption {
  return listeningStateOf(item) === 'heard'
    ? {
        id: 'mark-unplayed',
        label: $localize`:@@library.markUnplayed:Marcar como não ouvida`,
        icon: 'eyeOff',
      }
    : {
        id: 'mark-played',
        label: $localize`:@@library.markPlayed:Marcar como ouvida`,
        icon: 'checkcircle',
      };
}

/** Edit and copy the link (share on a phone), a group of their own after the first. */
function shareOptions(
  item: LibraryItem,
  { ready, phone }: { readonly ready: boolean; readonly phone: boolean },
  before: number,
): MenuOption[] {
  const options: MenuOption[] = [];
  if (item.canEdit)
    options.push({
      id: 'edit',
      label: editDetailsLabel(),
      icon: 'edit',
      divider: before > 0,
    });
  if (ready)
    options.push({
      id: 'copy-link',
      label: phone
        ? $localize`:@@library.share:Compartilhar`
        : $localize`:@@library.copyLink:Copiar link`,
      icon: phone ? 'share' : 'link',
      divider: before > 0 && options.length === 0,
    });
  return options;
}

/** A master's: "Tentar de novo" for a failed one, then "Remover". */
function masterOptions(
  item: LibraryItem,
  before: readonly MenuOption[],
): MenuOption[] {
  const options: MenuOption[] = [];
  if (item.canRetry)
    options.push({
      id: 'retry',
      label: $localize`:@@media.retry:Tentar de novo`,
      icon: 'refresh',
      divider: before.length > 0,
    });
  options.push({
    id: 'remove',
    label: $localize`:@@media.remove:Remover`,
    danger: true,
    icon: 'trash',
    divider: before.length > 0 && options.length === 0,
  });
  return options;
}
