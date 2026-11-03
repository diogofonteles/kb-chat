import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import { MEDIA_BOOKMARK_NOTE_MAX } from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { errorMessage } from '@core/api/api-error.js';
import { BookmarksStore } from '@core/media/bookmarks-store.js';

/**
 * The note of a bookmark just made (KBC-042 FR-2), under the player: the field takes the
 * focus, Enter saves, Esc closes without a note. When the server fails, the alert offers
 * "Tentar de novo" and the note stays in the field (NFR-1).
 */
@Component({
  selector: 'app-bookmark-note',
  template: `
    @if (failure(); as failed) {
      <div class="alert" role="alert">
        <p>{{ failureText() }}</p>
        @if (failed.kind === 'limit') {
          <button
            type="button"
            (click)="store.dismissFailure()"
            i18n="@@bookmarks.dismiss"
          >
            Fechar
          </button>
        } @else {
          <button
            type="button"
            (click)="store.retry()"
            i18n="@@bookmarks.retry"
          >
            Tentar de novo
          </button>
        }
      </div>
    }
    @if (bookmark(); as current) {
      <!-- No <form>: an Enter that opened the note (on 🔖) must not submit it too. -->
      <div class="note" role="group" aria-labelledby="bookmark-note-label">
        <label id="bookmark-note-label" for="bookmark-note" class="label">{{
          label()
        }}</label>
        <div class="row">
          <input
            #field
            id="bookmark-note"
            type="text"
            autocomplete="off"
            [maxLength]="noteMax"
            [value]="current.note ?? ''"
            (keydown.escape)="close($event)"
            (keydown.enter)="save($event, field.value)"
          />
          <button
            type="button"
            class="save"
            (click)="save($event, field.value)"
            i18n="@@bookmarks.save"
          >
            Salvar
          </button>
          <button
            type="button"
            class="dismiss"
            (click)="close($event)"
            i18n="@@bookmarks.close"
          >
            Fechar
          </button>
        </div>
      </div>
    }
  `,
  styleUrl: './bookmark-note.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookmarkNote {
  protected readonly store = inject(BookmarksStore);
  private readonly injector = inject(Injector);
  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');

  /** The note closed (saved or not): the focus goes back to "Marcar este trecho". */
  readonly closed = output();

  protected readonly noteMax = MEDIA_BOOKMARK_NOTE_MAX;
  protected readonly bookmark = computed(() => {
    const id = this.store.editing();
    return id === null
      ? null
      : (this.store.bookmarks().find((b) => b.id === id) ?? null);
  });
  protected readonly label = computed(() => {
    const at = this.bookmark()?.positionMs ?? 0;
    return $localize`:@@bookmarks.noteLabel:Nota do marcador em ${formatClock(at)}:time:`;
  });
  protected readonly failure = this.store.failed;
  protected readonly failureText = computed(() => {
    const failed = this.failure();
    if (failed?.kind === 'limit') return errorMessage('BOOKMARK_LIMIT');
    if (failed?.kind === 'delete')
      return $localize`:@@bookmarks.deleteFailed:Não consegui apagar o marcador.`;
    return failed && failed.count > 1
      ? $localize`:@@bookmarks.saveFailedMany:Não consegui salvar ${failed.count}:count: marcadores.`
      : $localize`:@@bookmarks.saveFailed:Não consegui salvar o marcador.`;
  });

  constructor() {
    // A note that opens takes the focus (a new bookmark, or one that failed to save).
    effect(() => {
      const id = this.store.editing();
      if (id === null) return;
      untracked(() =>
        afterNextRender(() => this.field()?.nativeElement.focus(), {
          injector: this.injector,
        }),
      );
    });
  }

  protected save(event: Event, text: string): void {
    event.preventDefault();
    const bookmark = this.bookmark();
    if (!bookmark) return;
    this.store.saveNote(bookmark.id, text);
    this.closed.emit();
  }

  protected close(event: Event): void {
    event.preventDefault();
    event.stopPropagation();
    this.store.editNote(null);
    this.closed.emit();
  }
}
