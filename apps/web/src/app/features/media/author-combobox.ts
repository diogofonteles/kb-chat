import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  model,
  signal,
} from '@angular/core';
import { authorListSchema } from '@kb-chat/contracts';
import { authorsUrl } from '@core/media/authors-api.js';
import { closeMatch, suggestAuthors } from './author-suggestions.js';

/** One line of the list: an author of the collection or the offer to register the text. */
interface AuthorOption {
  readonly key: string;
  /** What the field holds once chosen. */
  readonly name: string;
  readonly label: string;
  readonly main: boolean;
}

let nextId = 0;

/**
 * "Autor" (KBC-049 FR-3, screens.md T14): an editable combobox in the APG pattern. It
 * suggests the collection's authors (a sub-collection's are its parent's), the main one
 * first with ✦, and offers "Cadastrar «nome»" for a name the list does not have. The field
 * holds a name; the panel registers it on sending. Blank means "Outros autores".
 */
@Component({
  selector: 'app-author-combobox',
  templateUrl: './author-combobox.html',
  styleUrl: './author-combobox.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthorCombobox {
  /** The collection the audio goes to. */
  readonly topic = input.required<string>();
  readonly disabled = input(false);
  /** The author's name as typed or chosen. */
  readonly name = model('');

  private readonly id = `author-${nextId++}`;
  protected readonly inputId = `${this.id}-input`;
  protected readonly listId = `${this.id}-list`;
  protected readonly helpId = `${this.id}-help`;
  protected readonly statusId = `${this.id}-status`;

  /** The list is asked for once the person reaches the field, not before. */
  private readonly wanted = signal(false);
  private readonly list = httpResource(
    () =>
      this.wanted() && this.topic() ? authorsUrl(this.topic()) : undefined,
    { parse: (body) => authorListSchema.parse(body) },
  );
  private readonly authors = computed(() =>
    this.list.hasValue() ? this.list.value().items : [],
  );
  protected readonly open = signal(false);
  protected readonly active = signal(-1);
  protected readonly options = computed((): AuthorOption[] => {
    const { authors, register } = suggestAuthors(this.authors(), this.name());
    return [
      ...authors.map((author) => ({
        key: author.slug,
        name: author.name,
        label: author.name,
        main: author.main,
      })),
      ...(register
        ? [
            {
              key: '+new',
              name: register,
              label: $localize`:@@media.author.register:Cadastrar «${register}:name:»`,
              main: false,
            },
          ]
        : []),
    ];
  });
  /** The typed name is no author yet: it will be registered on sending (MA-27). */
  protected readonly newName = computed(() => {
    if (!this.list.hasValue()) return null;
    const { register } = suggestAuthors(this.authors(), this.name());
    return register;
  });
  /** An author the new name is probably a typo of ("você quis dizer…"). */
  protected readonly typoOf = computed(() =>
    this.newName() ? closeMatch(this.authors(), this.name()) : null,
  );
  protected readonly expanded = computed(
    () => this.open() && this.options().length > 0,
  );
  protected readonly activeId = computed(() =>
    this.expanded() && this.active() >= 0 ? this.optionId(this.active()) : null,
  );

  protected load(): void {
    this.wanted.set(true);
  }

  /** "Você quis dizer «Mestre Gabriel»?": takes the existing author instead. */
  protected takeSuggestion(name: string): void {
    this.name.set(name);
    this.close();
  }

  protected optionId(index: number): string {
    return `${this.listId}-${index}`;
  }

  protected typed(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.name.set(event.target.value);
    this.open.set(true);
    this.active.set(-1);
  }

  protected toggle(): void {
    this.open.update((open) => !open);
  }

  protected close(): void {
    this.open.set(false);
    this.active.set(-1);
  }

  /** A pointer choice: taken on press, so the field keeps the focus. */
  protected choose(event: MouseEvent, option: AuthorOption): void {
    event.preventDefault();
    this.pick(option);
  }

  protected pick(option: AuthorOption): void {
    this.name.set(option.name);
    this.close();
  }

  /** ↓/↑ move through the list (opening it), Enter chooses, Escape closes only the list. */
  protected keydown(event: KeyboardEvent): void {
    const count = this.options().length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      // Before the list arrives: open it, so it shows as soon as it does.
      this.open.set(true);
      if (count === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const from = this.expanded() ? this.active() : -1;
      const first = step > 0 ? 0 : count - 1;
      this.open.set(true);
      this.active.set(from < 0 ? first : (from + step + count) % count);
      return;
    }
    if (!this.expanded()) return;
    const chosen = this.options()[this.active()];
    if (event.key === 'Enter' && chosen) {
      event.preventDefault();
      this.pick(chosen);
    } else if (event.key === 'Escape') {
      // The panel is a dialog: Escape closes the list first, the dialog only after.
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }
}
