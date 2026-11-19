import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { UiCover } from '@ui/cover.js';
import { UiIcon } from '@ui/icon.js';
import { UiProgress } from '@ui/progress.js';
import type { LibraryItem } from '@kb-chat/contracts';
import { formatDuration } from '@kb-chat/player-core';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { percentOf, resumeTextOf, stateTextOf } from './library-labels.js';

/**
 * A media as a card (screens.md T16, v2 KBC-128): a 64 px shortcut tile in "Continuar
 * ouvindo" and a card in the grid view. The cover is the v2 typographic one (the title's
 * initials on its own gradient): lectures seldom have one. The title opens the player; ▶
 * plays at once from the saved position.
 */
@Component({
  // The host is the list item (role), so the list holds only items (axe "list").
  selector: 'app-library-card',
  imports: [RouterLink, UiCover, UiIcon, UiProgress],
  templateUrl: './library-card.html',
  styleUrl: './library-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card', role: 'listitem', '[class.tile]': 'tile()' },
})
export class LibraryCard {
  readonly item = input.required<LibraryItem>();
  readonly playing = input(false);
  /** A 64 px shortcut in "Continuar ouvindo" instead of the grid's card (KBC-128). */
  readonly tile = input(false);
  readonly played = output();

  protected readonly ready = computed(() => this.item().status === 'ready');
  /** "Irmã Helena Prado · 1:00" under the title (v2 Cartão: author · length). */
  protected readonly authorName = computed(
    () => this.item().author?.name ?? AUTHORSHIP_LABELS['outros-autores'],
  );
  protected readonly duration = computed(() => {
    const ms = this.item().durationMs;
    return ms === null ? '' : formatDuration(ms);
  });
  protected readonly resume = computed(() => resumeTextOf(this.item()));
  protected readonly state = computed(() => stateTextOf(this.item()));
  protected readonly percent = computed(() => percentOf(this.item()));
  protected readonly playLabel = computed(() =>
    this.playing()
      ? $localize`:@@library.pause:Pausar ${this.item().title}:title:`
      : $localize`:@@library.play:Tocar ${this.item().title}:title:`,
  );
}
