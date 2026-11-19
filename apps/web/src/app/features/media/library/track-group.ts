import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  model,
  output,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import type { LibraryItem, LibraryTrack } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { formatDuration } from '@kb-chat/player-core';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import { UiCover } from '@ui/cover.js';
import { UiIcon } from '@ui/icon.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { resumeTextOf, stateTextOf } from './library-labels.js';

/**
 * A recording's tracks in the library (KBC-068 FR-5): "12 faixas" opens them under it. The full
 * recording is the row above: each track here is an item of its own.
 */
@Component({
  selector: 'app-track-group',
  imports: [RouterLink, AuthorshipBadge, MenuButton, UiCover, UiIcon],
  host: { '[class.in-table]': '!toggle()' },
  templateUrl: './track-group.html',
  styleUrl: './track-group.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackGroup {
  private readonly session = inject(SessionStore);
  private readonly router = inject(Router);

  /** The ⋯ of a track (KBC-073 scope): it opens the track's page on what was chosen. */
  protected readonly canEdit = computed(
    () => this.session.me() !== null && this.session.can('media-edit'),
  );
  protected readonly trackOptions: readonly MenuOption[] = [
    { id: 'editar', label: $localize`:@@trackEdit.edit:Editar` },
    {
      id: 'limites',
      label: $localize`:@@trackEdit.bounds:Ajustar início e fim`,
    },
    {
      id: 'apagar',
      label: $localize`:@@trackEdit.delete:Apagar faixa`,
      danger: true,
    },
  ];

  readonly item = input.required<LibraryItem>();
  readonly playingId = input<string | null>(null);
  readonly played = output<LibraryTrack>();

  /**
   * Its own "3 faixas" button (a card of the grid). In the table the recording's row holds the
   * chevron (media-library-tracks: "3 faixas" pill, ⌄ at the row's end), and the tracks below
   * are rows of the table: ↳ n · cover · title · "faixa n de 3" · length · ⋯.
   */
  readonly toggle = input(true);
  readonly open = model(false);
  protected readonly label = computed(() => {
    const count = this.item().tracks.length;
    return count === 1
      ? $localize`:@@library.tracksOne:1 faixa`
      : $localize`:@@library.tracks:${count}:count: faixas`;
  });
  protected readonly listName = computed(
    () => $localize`:@@library.tracksOf:Faixas de ${this.item().title}:title:`,
  );
  protected readonly listId = computed(() => `tracks-${this.item().id}`);

  protected menuLabel(track: LibraryTrack): string {
    return $localize`:@@trackEdit.menu:Ações de ${track.title}:title:`;
  }

  protected chooseAction(track: LibraryTrack, action: string): void {
    void (action === 'limites'
      ? this.router.navigate(['/midia', track.id, 'limites'])
      : this.router.navigate(['/midia', track.id], {
          queryParams: { acao: action },
        }));
  }

  /** "faixa 2 de 3" (media-library-tracks). */
  protected placeOf(track: LibraryTrack): string {
    const parent = track.parent;
    if (!parent || parent.ordinal === null) return '';
    return $localize`:@@tracks.place:faixa ${parent.ordinal}:ordinal: de ${parent.total}:total:`;
  }

  protected durationOf(track: LibraryTrack): string {
    return track.durationMs === null ? '' : formatDuration(track.durationMs);
  }

  protected resumeOf(track: LibraryTrack): string {
    return resumeTextOf(track);
  }

  protected stateOf(track: LibraryTrack): string {
    return stateTextOf(track);
  }

  protected playLabel(track: LibraryTrack): string {
    return this.playingId() === track.id
      ? $localize`:@@library.pauseTrack:Pausar ${track.title}:title:`
      : $localize`:@@library.playTrack:Ouvir ${track.title}:title:`;
  }

  protected showsAuthor(track: LibraryTrack): boolean {
    return track.author?.slug !== this.item().author?.slug;
  }
}
