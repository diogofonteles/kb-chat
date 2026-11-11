import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { MEDIA_BOOKMARK_NOTE_MAX } from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { BookmarksStore } from '@core/media/bookmarks-store.js';
import { MediaEngine } from '@core/media/media-engine.js';

/**
 * "Marcadores" (screens.md T15, KBC-042 FR-3, FR-4): the person's bookmarks in this media,
 * by position, each with its note (or "Sem nota"). The time plays from there; the note is
 * edited in place; deleting shows "Desfazer" for 8 s, with no confirmation (UP-07).
 */
@Component({
  selector: 'app-bookmark-list',
  template: `
    <section class="bookmarks" aria-labelledby="bookmarks-title">
      <h3 id="bookmarks-title" #heading tabindex="-1">
        <span i18n="@@bookmarks.title">Marcadores</span>
        @if (bookmarks().length) {
          <span class="count">{{ bookmarks().length }}</span>
        }
      </h3>

      @if (store.deleted()) {
        <div class="undo">
          <span i18n="@@bookmarks.deletedShown">Marcador apagado</span>
          <button
            #undoButton
            type="button"
            (focus)="undoFocused(true)"
            (blur)="undoFocused(false)"
            (click)="undo()"
            i18n="@@bookmarks.undo"
          >
            Desfazer
          </button>
        </div>
      }

      @if (bookmarks().length === 0) {
        <p class="empty" i18n="@@bookmarks.empty">
          Nenhum marcador ainda. Use 🔖 ou a tecla B para marcar um trecho
          enquanto ouve.
        </p>
      } @else {
        <ol class="list">
          @for (bookmark of bookmarks(); track bookmark.id) {
            <li class="item" [attr.data-bookmark]="bookmark.id">
              <button
                type="button"
                class="time"
                [attr.aria-label]="playLabel(bookmark.positionMs)"
                (click)="play(bookmark.positionMs)"
              >
                {{ clock(bookmark.positionMs) }}
              </button>
              @if (editingId() === bookmark.id) {
                <!-- No <form>: the Enter that pressed "Editar" must not save too. -->
                <div class="edit">
                  <label
                    class="visually-hidden"
                    [attr.for]="'note-' + bookmark.id"
                    >{{ noteLabel(bookmark.positionMs) }}</label
                  >
                  <input
                    #editField
                    [id]="'note-' + bookmark.id"
                    type="text"
                    autocomplete="off"
                    [maxLength]="noteMax"
                    [value]="bookmark.note ?? ''"
                    (keydown.escape)="cancelEdit($event, bookmark.id)"
                    (keydown.enter)="
                      saveEdit($event, bookmark.id, editField.value)
                    "
                  />
                  <button
                    type="button"
                    (click)="saveEdit($event, bookmark.id, editField.value)"
                    i18n="@@bookmarks.save"
                  >
                    Salvar
                  </button>
                </div>
              } @else {
                <p class="note" [class.none]="bookmark.note === null">
                  {{ bookmark.note ?? noNote }}
                  @if (store.unsaved().has(bookmark.id)) {
                    <span class="saving" i18n="@@bookmarks.saving"
                      >salvando…</span
                    >
                  }
                </p>
                <div class="actions">
                  <button
                    type="button"
                    [attr.data-edit]="bookmark.id"
                    [attr.aria-label]="editLabel(bookmark.positionMs)"
                    (click)="startEdit(bookmark.id)"
                    i18n="@@bookmarks.edit"
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    [attr.aria-label]="deleteLabel(bookmark.positionMs)"
                    (click)="remove(bookmark.id)"
                    i18n="@@bookmarks.delete"
                  >
                    Apagar
                  </button>
                </div>
              }
            </li>
          }
        </ol>
      }
    </section>
  `,
  styleUrl: './bookmark-list.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BookmarkList {
  protected readonly store = inject(BookmarksStore);
  private readonly engine = inject(MediaEngine);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly undoButton =
    viewChild<ElementRef<HTMLButtonElement>>('undoButton');
  private readonly heading =
    viewChild.required<ElementRef<HTMLElement>>('heading');
  private undoHadFocus = false;

  protected readonly bookmarks = this.store.bookmarks;
  protected readonly editingId = signal<string | null>(null);
  protected readonly noteMax = MEDIA_BOOKMARK_NOTE_MAX;
  protected readonly noNote = $localize`:@@bookmarks.noNote:Sem nota`;

  protected clock(ms: number): string {
    return formatClock(ms);
  }

  /** Holds the time it shows, so voice control finds it by what it says (WCAG 2.5.3). */
  protected playLabel(ms: number): string {
    return $localize`:@@bookmarks.playFrom:Tocar de ${formatClock(ms)}:time:`;
  }

  protected noteLabel(ms: number): string {
    return $localize`:@@bookmarks.noteLabel:Nota do marcador em ${formatClock(ms)}:time:`;
  }

  protected editLabel(ms: number): string {
    return $localize`:@@bookmarks.editLabel:Editar a nota do marcador em ${formatClock(ms)}:time:`;
  }

  protected deleteLabel(ms: number): string {
    return $localize`:@@bookmarks.deleteLabel:Apagar o marcador em ${formatClock(ms)}:time:`;
  }

  /** The time plays from the bookmark (FR-3). */
  protected play(ms: number): void {
    this.engine.seek(ms);
    this.engine.play();
  }

  protected startEdit(id: string): void {
    this.editingId.set(id);
    this.focusLater(`#note-${id}`);
  }

  protected saveEdit(event: Event, id: string, text: string): void {
    event.preventDefault();
    this.store.saveNote(id, text);
    this.editingId.set(null);
    this.focusLater(`[data-edit="${id}"]`);
  }

  protected cancelEdit(event: Event, id: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.editingId.set(null);
    this.focusLater(`[data-edit="${id}"]`);
  }

  /** Gone at once; the focus goes to "Desfazer", the way back (FR-4, NG-30). */
  protected remove(id: string): void {
    if (this.editingId() === id) this.editingId.set(null);
    this.store.remove(id);
    afterNextRender(() => this.undoButton()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  /** The bookmark is back: the focus goes to its time. */
  protected undo(): void {
    const id = this.store.deleted()?.id;
    this.store.undo();
    if (id) this.focusLater(`[data-bookmark="${id}"] .time`);
  }

  constructor() {
    // "Desfazer" goes when its 8 s end: a focus on it moves to the list's heading (NG-30).
    effect(() => {
      if (this.store.deleted() !== null) return;
      untracked(() => {
        if (!this.undoHadFocus) return;
        this.undoHadFocus = false;
        afterNextRender(
          () => {
            const active = this.host.nativeElement.ownerDocument.activeElement;
            if (!active || active === active.ownerDocument.body)
              this.heading().nativeElement.focus();
          },
          { injector: this.injector },
        );
      });
    });
  }

  protected undoFocused(focused: boolean): void {
    this.undoHadFocus = focused;
  }

  /** Bookmark ids are uuids: safe in a selector as they are. */
  private focusLater(selector: string): void {
    afterNextRender(
      () =>
        this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(),
      { injector: this.injector },
    );
  }
}
