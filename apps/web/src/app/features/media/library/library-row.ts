import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
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
  | 'play-next'
  | 'bookmarks'
  | 'mark-played'
  | 'mark-unplayed'
  | 'select'
  | 'select-all'
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
    NgTemplateOutlet,
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
    '[class.has-tracks]': 'tracksLabel() !== ""',
    '(pointerdown)': 'pressStarted($event)',
    '(pointermove)': 'pressMoved($event)',
    '(pointerup)': 'pressEnded()',
    '(pointercancel)': 'pressEnded()',
    '(contextmenu)': 'contextMenu($event)',
    '(keydown)': 'keyPressed($event)',
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
  /**
   * The phone's row (media-library@mobile): a long press (or the context menu: the menu key,
   * Android's long press) starts a selection — its ⋯ has no "Selecionar"
   * (media-library-row-menu@mobile) — and the ⋯ says "Compartilhar".
   */
  readonly phone = input(false);
  /**
   * During a selection on a phone, "Selecionar todas as N" (the table's box has no place
   * there): its words, or '' when there is nothing more to select.
   */
  readonly selectAll = input('');
  /** Where this media's preparation stopped (KBC-072 FR-6). */
  readonly paused = input<PreparationStep | null>(null);
  /** Its tracks show under it (media-library-tracks): the chevron at the row's end turns. */
  readonly tracksOpen = input(false);
  readonly played = output();
  readonly tracksToggled = output();
  readonly selectedChange = output<boolean>();
  readonly acted = output<RowAction>();

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  /** The long press under way: where it started and its timer. */
  private press: {
    readonly x: number;
    readonly y: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** A long press just selected: the click that ends it opens nothing. */
  private pressedLong = false;

  constructor() {
    const swallow = (event: MouseEvent): void => {
      if (!this.pressedLong) return;
      this.pressedLong = false;
      event.preventDefault();
      event.stopPropagation();
    };
    const element = this.host.nativeElement;
    element.addEventListener('click', swallow, { capture: true });
    inject(DestroyRef).onDestroy(() => {
      element.removeEventListener('click', swallow, { capture: true });
      this.pressEnded();
    });
  }

  /** The author by name, "Outros autores" with none (media-library: plain, muted). */
  protected readonly authorName = computed(
    () =>
      this.item().author?.name ??
      $localize`:@@authorship.others:Outros autores`,
  );
  /** "3 faixas" (pill and the chevron's name); empty for a media with no tracks. */
  protected readonly tracksLabel = computed(() => {
    const count = this.item().tracks.length;
    if (count === 0) return '';
    return count === 1
      ? $localize`:@@library.tracksOne:1 faixa`
      : $localize`:@@library.tracks:${count}:count: faixas`;
  });
  protected readonly tracksId = computed(() => `tracks-${this.item().id}`);
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
   * The ⋯ (media-library-row-menu; a sheet on a phone, @mobile): play, mark, "Selecionar todas"
   * during a phone's selection,
   * edit and copy the link, then "Tentar de novo" and "Remover" for masters.
   */
  protected readonly options = computed<readonly MenuOption[]>(() => {
    const ready = this.ready();
    const phone = this.phone();
    const options = listenOptions(this.item(), ready, phone);
    const all = this.selectAll();
    if (phone && all && ready)
      options.push({ id: 'select-all', label: all, icon: 'checkcircle' });
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

  protected pressStarted(event: PointerEvent): void {
    this.pressEnded();
    this.pressedLong = false;
    if (!this.phone() || !this.ready() || event.button !== 0) return;
    // Not from the row's own controls: the ⋯, ▶, the box and the chevron keep their tap.
    if (onControl(event)) return;
    this.press = {
      x: event.clientX,
      y: event.clientY,
      timer: setTimeout(() => {
        this.press = null;
        this.pressedLong = true;
        this.acted.emit('select');
      }, LONG_PRESS_MS),
    };
  }

  /** A finger that scrolls is not pressing. */
  protected pressMoved(event: PointerEvent): void {
    if (!this.press) return;
    const moved = Math.hypot(
      event.clientX - this.press.x,
      event.clientY - this.press.y,
    );
    if (moved > PRESS_SLOP_PX) this.pressEnded();
  }

  protected pressEnded(): void {
    if (this.press) clearTimeout(this.press.timer);
    this.press = null;
  }

  /** The context menu on a phone's row selects it (no browser menu over the row). */
  protected contextMenu(event: MouseEvent): void {
    if (!this.phone() || !this.ready() || onControl(event)) return;
    event.preventDefault();
    if (this.pressedLong) return;
    this.pressEnded();
    this.acted.emit('select');
  }

  /** The keyboard's context menu (the menu key, Shift+F10) selects it too, on a phone. */
  protected keyPressed(event: KeyboardEvent): void {
    const menuKey =
      event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10');
    if (!menuKey || !this.phone() || !this.ready() || onControl(event)) return;
    event.preventDefault();
    this.acted.emit('select');
  }

  protected toggleSelected(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.selectedChange.emit(event.target.checked);
  }
}

/** On one of the row's own controls (⋯, ▶, the box, the chevron), which keep their own use. */
function onControl(event: Event): boolean {
  return (
    event.target instanceof Element &&
    event.target.closest('button, input, app-menu-button') !== null
  );
}

/** How long a finger stays on a phone's row to select it, and how far it may drift. */
const LONG_PRESS_MS = 500;
const PRESS_SLOP_PX = 10;

const ACTIONS: readonly RowAction[] = [
  'play',
  'play-next',
  'bookmarks',
  'mark-played',
  'mark-unplayed',
  'select',
  'select-all',
  'edit',
  'copy-link',
  'retry',
  'remove',
];

/**
 * Play (not on a phone: a tap on the cover plays), play next, mark heard or not, its
 * bookmarks (a phone starts a selection with a long press: media-library-row-menu@mobile).
 */
function listenOptions(
  item: LibraryItem,
  ready: boolean,
  phone: boolean,
): MenuOption[] {
  if (!ready) return [];
  const play: MenuOption = {
    id: 'play',
    label: $localize`:@@library.playNow:Tocar agora`,
    icon: 'play',
  };
  const next: MenuOption = {
    id: 'play-next',
    label: $localize`:@@library.playNext:Tocar em seguida`,
    icon: 'queue',
  };
  const bookmarks: MenuOption = {
    id: 'bookmarks',
    label: $localize`:@@library.seeBookmarks:Ver marcadores`,
    icon: 'bookmark',
  };
  return phone
    ? [next, markOption(item), bookmarks]
    : [play, next, markOption(item), bookmarks];
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
