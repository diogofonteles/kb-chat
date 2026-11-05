import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  SPEAKER_NAME_MAX,
  type Author,
  type CollectionSpeaker,
} from '@kb-chat/contracts';
import {
  isInvalidSpeakerName,
  optionForText,
  suggestSpeakers,
  type SpeakerChoice,
  type SpeakerOption,
} from './speaker-suggestions.js';

let nextId = 0;

/** About what the field shows at 390 px: a longer name wraps below it, never cut (T15). */
const FIELD_CHARS = 40;

/**
 * "Quem é a Voz N?" (screens.md T15, KBC-065): an editable combobox in the APG pattern, as
 * the author's (KBC-049). Choosing an option saves it at once: the panel does the saving and
 * the field shows what the voice is. A text left unchosen goes back to that on leaving.
 */
@Component({
  selector: 'app-speaker-combobox',
  templateUrl: './speaker-combobox.html',
  styleUrl: './speaker-combobox.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'speaker-combobox' },
})
export class SpeakerCombobox {
  readonly voice = input.required<number>();
  /** What the voice is now; '' with no name. */
  readonly current = input('');
  readonly speakers = input<readonly CollectionSpeaker[]>([]);
  readonly authors = input<readonly Author[]>([]);
  /** The lists are on their way: a name typed now may be on them, so none is registered. */
  readonly loading = input(false);
  readonly chosen = output<SpeakerChoice>();

  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private readonly id = `speaker-${nextId++}`;
  protected readonly inputId = `${this.id}-input`;
  protected readonly listId = `${this.id}-list`;
  protected readonly errorId = `${this.id}-error`;
  protected readonly nameMax = SPEAKER_NAME_MAX;

  /** The field's text: what the voice is, until the person types. */
  protected readonly text = linkedSignal(() => this.current());
  /** Enter on a blank field: said at the field (AC-7). */
  private readonly blankTried = signal(false);
  protected readonly invalid = computed(
    () => this.blankTried() || isInvalidSpeakerName(this.text()),
  );
  /** The field is one line: the name in full goes under it. Readers already get the value. */
  protected readonly wholeName = computed(() => {
    const name = this.current();
    return name.length > FIELD_CHARS && this.text() === name ? name : '';
  });
  protected readonly open = signal(false);
  protected readonly active = signal(-1);
  protected readonly options = computed(() => {
    const options = suggestSpeakers({
      speakers: this.speakers(),
      authors: this.authors(),
      text: this.text(),
      current: this.current(),
    });
    return this.loading()
      ? options.filter(({ key }) => key !== '+new')
      : options;
  });
  protected readonly expanded = computed(
    () => this.open() && (this.options().length > 0 || this.loading()),
  );
  protected readonly activeId = computed(() =>
    this.expanded() && this.active() >= 0 ? this.optionId(this.active()) : null,
  );

  /** Where the person types, with the name selected to be typed over. */
  focus(): void {
    const field = this.field()?.nativeElement;
    field?.focus();
    field?.select();
  }

  protected optionId(index: number): string {
    return `${this.listId}-${index}`;
  }

  protected typed(event: Event): void {
    if (!(event.target instanceof HTMLInputElement)) return;
    this.text.set(event.target.value);
    this.blankTried.set(false);
    this.open.set(true);
    this.active.set(-1);
  }

  protected toggle(): void {
    this.open.update((open) => !open);
  }

  /** Leaving without choosing saves nothing: an invalid text stays, with its error. */
  protected leave(): void {
    this.close();
    if (!isInvalidSpeakerName(this.text())) this.text.set(this.current());
    this.blankTried.set(false);
  }

  /** A pointer choice: taken on press, so the field keeps the focus. */
  protected choose(event: MouseEvent, option: SpeakerOption): void {
    event.preventDefault();
    this.pick(option);
  }

  /** ↓/↑ move through the list (opening it), Enter chooses, Escape closes only the list. */
  protected keydown(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
      return this.move(event);
    if (event.key === 'Enter') return this.enter(event);
    if (event.key === 'Escape' && this.expanded()) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
    }
  }

  private move(event: KeyboardEvent): void {
    event.preventDefault();
    const count = this.options().length;
    this.open.set(true);
    if (count === 0) return;
    const step = event.key === 'ArrowDown' ? 1 : -1;
    const first = step > 0 ? 0 : count - 1;
    const from = this.active();
    this.active.set(from < 0 ? first : (from + step + count) % count);
  }

  /** Saves only what was chosen or spelled out: anything else asks for a choice (UP-06). */
  private enter(event: KeyboardEvent): void {
    event.preventDefault();
    const chosen = this.enterChoice();
    if (chosen) return this.pick(chosen);
    const text = this.text().trim();
    if (text === '') this.blankTried.set(true);
    else if (text === this.current().trim()) this.close();
    else this.open.set(true);
  }

  private enterChoice(): SpeakerOption | undefined {
    const options = this.options();
    const active = options[this.active()];
    if (active) return active;
    const text = this.text();
    return text.trim() === this.current().trim()
      ? undefined
      : optionForText(options, text);
  }

  private pick(option: SpeakerOption): void {
    this.close();
    this.chosen.emit(option.choice);
  }

  private close(): void {
    this.open.set(false);
    this.active.set(-1);
  }
}
