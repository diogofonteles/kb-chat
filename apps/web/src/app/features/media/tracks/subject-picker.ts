import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  SUBJECT_NAME_MAX,
  subjectKey,
  type CollectionSubjects,
  type SubjectRef,
} from '@kb-chat/contracts';

/** What a person picked: an existing subject or a name to create. */
export type SubjectChoice =
  SubjectRef | { readonly kind: 'create'; readonly name: string };

interface SubjectOption {
  readonly key: string;
  readonly label: string;
  readonly choice: SubjectChoice;
}

/** A list short enough to scan on a phone; typing narrows it (SL). */
const MAX_OPTIONS = 8;

let nextId = 0;

/**
 * "Adicionar assunto" (KBC-069): an editable combobox in the APG pattern, as the author's. It
 * lists the collection's concepts and free subjects and offers to create what it lacks.
 */
@Component({
  selector: 'app-subject-picker',
  templateUrl: './subject-picker.html',
  styleUrl: './subject-picker.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SubjectPicker {
  readonly collection = input.required<CollectionSubjects>();
  /** Names already on the track, by `subjectKey`. */
  readonly taken = input<readonly string[]>([]);
  readonly disabled = input(false);
  /** Names the field after the track. */
  readonly label = input.required<string>();
  readonly chosen = output<SubjectChoice>();

  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private readonly id = `subject-${nextId++}`;
  protected readonly inputId = `${this.id}-input`;
  protected readonly listId = `${this.id}-list`;
  protected readonly nameMax = SUBJECT_NAME_MAX;

  protected readonly text = signal('');
  protected readonly open = signal(false);
  protected readonly active = signal(-1);

  private readonly all = computed((): SubjectOption[] => {
    const { concepts, free } = this.collection();
    return [
      ...concepts.map((name) => ({
        key: subjectKey(name),
        label: name,
        choice: { kind: 'concept', name } as const,
      })),
      ...free.map(({ id, name }) => ({
        key: subjectKey(name),
        label: name,
        choice: { kind: 'free', id } as const,
      })),
    ];
  });
  protected readonly options = computed((): SubjectOption[] => {
    const typed = subjectKey(this.text());
    const taken = this.taken();
    const found = this.all().filter(
      (option) => option.key.includes(typed) && !taken.includes(option.key),
    );
    const shown = found.slice(0, MAX_OPTIONS);
    const exists = this.all().some((option) => option.key === typed);
    if (!typed || exists) return shown;
    const name = this.text().trim();
    return [
      ...shown,
      {
        key: '+new',
        label: $localize`:@@subjects.create:Criar assunto «${name}:name:»`,
        choice: { kind: 'create', name },
      },
    ];
  });
  protected readonly expanded = computed(
    () => this.open() && this.options().length > 0,
  );
  protected readonly activeId = computed(() =>
    this.expanded() && this.active() >= 0 ? this.optionId(this.active()) : null,
  );

  protected optionId(index: number): string {
    return `${this.id}-option-${index}`;
  }

  /** The way back after a chip that had the focus is gone (WCAG 2.4.3). */
  focus(): void {
    this.field()?.nativeElement.focus();
  }

  protected typed(event: Event): void {
    this.text.set((event.target as HTMLInputElement).value);
    this.open.set(true);
    this.active.set(-1);
  }

  protected close(): void {
    this.open.set(false);
    this.active.set(-1);
  }

  protected keydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const option = this.options()[Math.max(this.active(), 0)];
      if (option && this.expanded()) this.pick(option);
    } else if (event.key === 'Escape') this.close();
  }

  private move(step: 1 | -1): void {
    const count = this.options().length;
    if (count === 0) return;
    this.open.set(true);
    this.active.update((now) => (now + step + count) % count);
  }

  protected choose(event: Event, option: SubjectOption): void {
    // The field keeps the focus: `blur` would close the list before the press lands.
    event.preventDefault();
    this.pick(option);
  }

  private pick(option: SubjectOption): void {
    this.chosen.emit(option.choice);
    this.text.set('');
    this.close();
  }
}
