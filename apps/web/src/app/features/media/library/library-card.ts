import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { LibraryItem } from '@kb-chat/contracts';
import { formatDuration } from '@kb-chat/player-core';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import {
  coverToneOf,
  initialsOf,
  percentOf,
  resumeTextOf,
  stateTextOf,
} from './library-labels.js';

/**
 * A media as a card (screens.md T16): in "Continuar ouvindo" and in the grid view. The
 * cover is generated (the title's initials on the collection's tone): lectures seldom
 * have one. The title opens the player; ▶ plays at once from the saved position.
 */
@Component({
  // The host is the list item (role), so the list holds only items (axe "list").
  selector: 'app-library-card',
  imports: [RouterLink, AuthorshipBadge],
  templateUrl: './library-card.html',
  styleUrl: './library-card.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'card', role: 'listitem' },
})
export class LibraryCard {
  readonly item = input.required<LibraryItem>();
  readonly playing = input(false);
  readonly played = output();

  protected readonly ready = computed(() => this.item().status === 'ready');
  protected readonly initials = computed(() => initialsOf(this.item().title));
  protected readonly tone = computed(() => coverToneOf(this.item().topic));
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
