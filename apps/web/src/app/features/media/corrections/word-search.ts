import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { formatClock } from '@kb-chat/player-core';
import { debounceTime, distinctUntilChanged, map } from 'rxjs';
import type { TextLine } from '../tracks/track-text-lines.js';

/** Results listed at most: the person types more to narrow them. */
export const SEARCH_LIMIT = 50;
const DEBOUNCE_MS = 150;
/** Characters of context on each side of an occurrence. */
const CONTEXT_CHARS = 30;

/** An occurrence of the typed text in a line. */
export interface WordHit {
  readonly line: number;
  readonly segment: number;
  /** Where it starts in the line's text. */
  readonly offset: number;
  readonly clock: string;
  readonly before: string;
  readonly match: string;
  readonly after: string;
}

/** Text as the search compares it: no case, no accents (same length, so offsets hold). */
const folded = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase('pt-BR');

/** Folding keeps one character per character only for precomposed text; else it is off. */
const foldsInPlace = (text: string) => folded(text).length === text.length;

function hitsIn(line: TextLine, index: number, query: string): WordHit[] {
  const text = foldsInPlace(line.text) ? folded(line.text) : line.text;
  const hits: WordHit[] = [];
  for (
    let at = text.indexOf(query);
    at >= 0;
    at = text.indexOf(query, at + 1)
  ) {
    const word = line.words?.findLast((one) => one.charStart <= at);
    hits.push({
      line: index,
      segment: line.segment,
      offset: at,
      clock: formatClock(word?.startMs ?? line.startMs),
      before: line.text.slice(Math.max(0, at - CONTEXT_CHARS), at),
      match: line.text.slice(at, at + query.length),
      after: line.text.slice(
        at + query.length,
        at + query.length + CONTEXT_CHARS,
      ),
    });
  }
  return hits;
}

/**
 * "Procurar palavra" (KBC-093 FR-4): the keyboard and screen reader way to a word, since
 * the words of the text are not in the Tab order (KBC-092 AC-15). Each occurrence is a
 * button with its time and context; choosing one goes to the word as a click does.
 */
@Component({
  selector: 'app-word-search',
  templateUrl: './word-search.html',
  styleUrl: './word-search.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WordSearch {
  readonly lines = input.required<readonly TextLine[]>();
  readonly chosen = output<WordHit>();

  private readonly field = viewChild<ElementRef<HTMLInputElement>>('field');
  private readonly results =
    viewChildren<ElementRef<HTMLButtonElement>>('result');

  protected readonly query = signal('');
  private readonly settled = toSignal(
    toObservable(this.query).pipe(
      debounceTime(DEBOUNCE_MS),
      map((text) => folded(text.trim())),
      distinctUntilChanged(),
    ),
    { initialValue: '' },
  );
  protected readonly hits = computed(() => {
    const query = this.settled();
    if (query.length < 2) return [];
    return this.lines()
      .flatMap((line, index) => hitsIn(line, index, query))
      .slice(0, SEARCH_LIMIT + 1);
  });
  protected readonly shown = computed(() => this.hits().slice(0, SEARCH_LIMIT));
  protected readonly more = computed(() => this.hits().length > SEARCH_LIMIT);
  private lastChosen = -1;

  protected typed(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.query.set(event.target.value);
  }

  protected choose(hit: WordHit, index: number): void {
    this.lastChosen = index;
    this.chosen.emit(hit);
  }

  /** After the panel closes: back on the occurrence chosen, or the field (AC-22). */
  refocus(): void {
    const result = this.results()[this.lastChosen]?.nativeElement;
    (result ?? this.field()?.nativeElement)?.focus();
  }
}
