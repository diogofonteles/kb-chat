import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  TOPIC_DESCRIPTION_MAX,
  TOPIC_TITLE_MAX,
  authorListSchema,
  topicSlugOf,
  type Topic,
  type TopicUpdate,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { KbApi } from '@core/api/kb-api.js';
import { authorsUrl } from '@core/media/authors-api.js';
import type { Observable } from 'rxjs';

/** No parent: a top-level collection. */
const TOP_LEVEL = '';
/** No main author ("Nenhum"). */
const NO_AUTHOR = '';

/**
 * "Novo acervo" and "Editar acervo" (KBC-048 FR-6, FR-2): name, short description and, when
 * creating, the collection it goes in (top level only, BR-2); the address it gets is shown
 * before creating and never changes (BR-4). Editing a top-level collection also chooses its
 * main author among its authors (KBC-049 FR-2); a sub-collection uses its parent's. Esc and
 * "Cancelar" close it, and the browser gives the focus back to the button that opened it.
 */
@Component({
  selector: 'app-collection-dialog',
  template: `
    <dialog
      #dialog
      class="dialog"
      aria-labelledby="collection-title"
      (close)="closed.emit()"
    >
      <h2 id="collection-title">
        @if (editing()) {
          <ng-container i18n="@@collection.editTitle"
            >Editar acervo</ng-container
          >
        } @else {
          <ng-container i18n="@@collection.newTitle">Novo acervo</ng-container>
        }
      </h2>
      <!-- A form: Enter in the name creates (or saves), like any form. -->
      <form (submit)="$event.preventDefault(); save()">
        <label class="field" for="collection-name">
          <span i18n="@@collection.name">Nome</span>
          <input
            #nameInput
            id="collection-name"
            type="text"
            autocomplete="off"
            [attr.maxlength]="titleMax"
            [value]="name()"
            [attr.aria-invalid]="invalid() ? 'true' : null"
            [attr.aria-describedby]="
              invalid() ? 'collection-name-error' : 'collection-address'
            "
            (input)="typeName(nameInput.value)"
          />
        </label>
        @if (invalid()) {
          <p
            id="collection-name-error"
            class="error"
            i18n="@@collection.nameRequired"
          >
            Escreva um nome com pelo menos uma letra ou número.
          </p>
        }
        <p id="collection-address" class="hint">
          @if (address(); as where) {
            <ng-container i18n="@@collection.address"
              >Identificador (não muda depois):
              <code>{{ where }}</code></ng-container
            >
          }
        </p>
        <label class="field" for="collection-description">
          <span i18n="@@collection.description">Descrição (opcional)</span>
          <textarea
            #descriptionInput
            id="collection-description"
            rows="2"
            [attr.maxlength]="descriptionMax"
            [value]="description()"
            (input)="description.set(descriptionInput.value)"
          ></textarea>
        </label>
        @if (choosesMainAuthor()) {
          <label class="field" for="collection-main-author">
            <span i18n="@@collection.mainAuthor">Autor principal</span>
            <select
              #mainAuthorSelect
              id="collection-main-author"
              aria-describedby="collection-main-author-hint"
              (change)="mainAuthor.set(mainAuthorSelect.value)"
            >
              <option
                [value]="noAuthor"
                [selected]="mainAuthor() === noAuthor"
                i18n="@@collection.noMainAuthor"
              >
                Nenhum
              </option>
              @for (author of authors(); track author.slug) {
                <option
                  [value]="author.slug"
                  [selected]="mainAuthor() === author.slug"
                >
                  {{ author.name }}
                </option>
              }
            </select>
          </label>
          <p id="collection-main-author-hint" class="hint">
            @if (authors().length === 0 && authorList.hasValue()) {
              <ng-container i18n="@@collection.noAuthorsYet"
                >Este acervo ainda não tem autores: eles são cadastrados ao
                enviar um áudio.</ng-container
              >
            } @else {
              <ng-container i18n="@@collection.mainAuthorHint"
                >Aparece com ✦ nos selos e filtros, e a IA nunca atribui a ele o
                que é de outros autores.</ng-container
              >
            }
          </p>
        }
        @if (!editing()) {
          <label class="field" for="collection-parent">
            <span i18n="@@collection.parent">Dentro de</span>
            <select
              #parentSelect
              id="collection-parent"
              (change)="parent.set(parentSelect.value)"
            >
              <option
                [value]="topLevel"
                [selected]="parent() === topLevel"
                i18n="@@collection.noParent"
              >
                Nenhum (acervo principal)
              </option>
              @for (option of parents(); track option.slug) {
                <option
                  [value]="option.slug"
                  [selected]="parent() === option.slug"
                >
                  {{ option.title }}
                </option>
              }
            </select>
          </label>
        }
        @if (failure(); as message) {
          <p class="error" role="alert">{{ message }}</p>
        }
        <div class="actions">
          <button
            type="button"
            class="secondary"
            (click)="close()"
            i18n="@@collection.cancel"
          >
            Cancelar
          </button>
          <button
            type="submit"
            class="primary"
            [disabled]="busy()"
            [attr.aria-busy]="busy()"
          >
            @if (busy()) {
              <ng-container i18n="@@collection.saving">Salvando…</ng-container>
            } @else if (editing()) {
              <ng-container i18n="@@collection.save">Salvar</ng-container>
            } @else {
              <ng-container i18n="@@collection.create"
                >Criar acervo</ng-container
              >
            }
          </button>
        </div>
      </form>
    </dialog>
  `,
  styleUrl: './collection-dialog.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CollectionDialog {
  private readonly api = inject(KbApi);
  private readonly dialog =
    viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly nameInput =
    viewChild.required<ElementRef<HTMLInputElement>>('nameInput');

  /** Every collection the person sees; the top-level ones they open can hold a new one. */
  readonly topics = input.required<readonly Topic[]>();
  readonly saved = output<Topic>();
  readonly closed = output();

  protected readonly titleMax = TOPIC_TITLE_MAX;
  protected readonly descriptionMax = TOPIC_DESCRIPTION_MAX;
  protected readonly topLevel = TOP_LEVEL;
  protected readonly noAuthor = NO_AUTHOR;
  /** The main author chosen in the dialog (its id), or "" for none. */
  protected readonly mainAuthor = signal(NO_AUTHOR);
  protected readonly editing = signal<Topic | null>(null);
  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly parent = signal(TOP_LEVEL);
  protected readonly invalid = signal(false);
  protected readonly busy = signal(false);
  protected readonly failure = signal<string | null>(null);

  /**
   * One level only (BR-2): a sub-collection is never offered as a parent, nor a vault topic
   * that sits in a folder ("harness/goclaw", which the API refuses as a parent).
   */
  protected readonly parents = computed(() =>
    this.topics().filter(
      (topic) =>
        topic.parent === null && topic.canOpen && !topic.slug.includes('/'),
    ),
  );

  /** Only a top-level collection chooses its main author (KBC-049 BR-1). */
  protected readonly choosesMainAuthor = computed(
    () => this.editing()?.parent === null,
  );
  protected readonly authorList = httpResource(
    () => {
      const current = this.editing();
      return current && this.choosesMainAuthor()
        ? authorsUrl(current.slug)
        : undefined;
    },
    { parse: (body) => authorListSchema.parse(body) },
  );
  protected readonly authors = computed(() =>
    this.authorList.hasValue() ? this.authorList.value().items : [],
  );

  /** The address the collection gets (or keeps, when editing). */
  protected readonly address = computed(() => {
    const current = this.editing();
    if (current) return current.slug;
    const base = topicSlugOf(this.name());
    if (!base) return '';
    return this.parent() === TOP_LEVEL ? base : `${this.parent()}/${base}`;
  });

  /** A new collection, inside `parent` when given. */
  openNew(parent: string | null = null): void {
    this.reset(null);
    const fits = this.parents().some((topic) => topic.slug === parent);
    this.parent.set(parent !== null && fits ? parent : TOP_LEVEL);
    this.show();
  }

  /** New names for an existing collection. */
  openEdit(topic: Topic): void {
    this.reset(topic);
    this.name.set(topic.title);
    this.description.set(topic.description);
    this.mainAuthor.set(topic.mainAuthor?.slug ?? NO_AUTHOR);
    this.show();
  }

  protected typeName(value: string): void {
    this.name.set(value);
    this.invalid.set(false);
  }

  protected close(): void {
    this.dialog().nativeElement.close();
  }

  protected save(): void {
    const title = this.name().trim();
    if (!topicSlugOf(title)) {
      this.invalid.set(true);
      this.nameInput().nativeElement.focus();
      return;
    }
    this.busy.set(true);
    this.failure.set(null);
    this.request(title).subscribe({
      next: (topic) => {
        this.busy.set(false);
        this.saved.emit(topic);
        this.close();
      },
      error: (error: unknown) => {
        this.busy.set(false);
        this.failure.set(errorMessage(toUiErrorCode(error)));
      },
    });
  }

  private request(title: string): Observable<Topic> {
    const description = this.description().trim();
    const current = this.editing();
    if (current)
      return this.api.renameTopic(current.slug, this.changes(current, title));
    const parent = this.parent() === TOP_LEVEL ? null : this.parent();
    return this.api.createTopic({ title, description, parent });
  }

  /** The names, and the main author only when it changed (KBC-049 FR-2). */
  private changes(current: Topic, title: string): TopicUpdate {
    const description = this.description().trim();
    const chosen = this.mainAuthor() || null;
    const changed =
      this.choosesMainAuthor() && chosen !== (current.mainAuthor?.slug ?? null);
    return changed
      ? { title, description, mainAuthor: chosen }
      : { title, description };
  }

  private reset(editing: Topic | null): void {
    this.editing.set(editing);
    this.name.set('');
    this.description.set('');
    this.parent.set(TOP_LEVEL);
    this.mainAuthor.set(NO_AUTHOR);
    this.invalid.set(false);
    this.failure.set(null);
    this.busy.set(false);
  }

  private show(): void {
    this.dialog().nativeElement.showModal();
  }
}
