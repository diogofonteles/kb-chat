import { computed, linkedSignal, type Signal } from '@angular/core';
import type {
  MediaTranscript,
  MediaTranscriptWords,
  TranscriptWord,
} from '@kb-chat/contracts';
import { alignWords, type SpokenWord } from '@kb-chat/player-core';
import {
  EMPTY,
  catchError,
  finalize,
  of,
  share,
  tap,
  type Observable,
} from 'rxjs';

/** Segments asked for at a time: about 1 300 words of a 2 h transcript's 20 000. */
export const WORDS_PAGE_SEGMENTS = 100;

type AskForWords = (
  mediaId: string,
  range: { readonly from: number; readonly count: number },
) => Observable<MediaTranscriptWords>;

/**
 * A word placed in its segment's text, with its place in the transcript and its own text
 * (a correction names them, KBC-093). Empty words have no place in the text: they are
 * not here.
 */
export interface PlacedWord extends SpokenWord {
  readonly position: number | null;
  readonly text: string;
}

type PageWords = ReadonlyMap<number, readonly PlacedWord[]>;

/** The page a segment's words come in. */
export const wordsPageOf = (segment: number): number =>
  Math.floor(segment / WORDS_PAGE_SEGMENTS);

function groupBySegment(
  words: readonly TranscriptWord[],
): Map<number, TranscriptWord[]> {
  const bySegment = new Map<number, TranscriptWord[]>();
  for (const word of words) {
    const group = bySegment.get(word.segment);
    if (group) group.push(word);
    else bySegment.set(word.segment, [word]);
  }
  return bySegment;
}

/**
 * The transcript's words (KBC-045 FR-1), a page at a time, placed in the text of their
 * segments. They are not part of the transcript: reading one never scans the 20 000 words
 * of a 2 h lecture (KBC-038 NFR-2), and most of them are never needed. A page that fails
 * stays unasked: its segments keep their own highlight until something asks again.
 */
export class TranscriptWords {
  /** Which transcript the words are for: its media, version and revision (KBC-093). */
  readonly key = computed(() => keyOf(this.transcript()));
  private readonly pages = linkedSignal<string, ReadonlyMap<number, PageWords>>(
    {
      source: this.key,
      computation: () => new Map(),
    },
  );
  private readonly asking = new Map<string, Observable<unknown>>();

  constructor(
    private readonly transcript: Signal<MediaTranscript>,
    private readonly askForWords: AskForWords,
  ) {}

  /** A segment's words; empty without word times; null while its page is not here. */
  of(segment: number): readonly PlacedWord[] | null {
    const page = this.pages().get(wordsPageOf(segment));
    return page ? (page.get(segment) ?? NO_WORDS) : null;
  }

  /** Brings a page in; completes without a value when it cannot be had. */
  load(page: number): Observable<unknown> {
    if (this.pages().has(page)) return of(page);
    const key = `${this.key()}.${page}`;
    const asked = this.asking.get(key) ?? this.ask(page, key);
    this.asking.set(key, asked);
    return asked;
  }

  private ask(page: number, key: string): Observable<unknown> {
    const transcript = this.transcript();
    const { mediaId, segments } = transcript;
    return this.askForWords(mediaId, {
      from: page * WORDS_PAGE_SEGMENTS,
      count: WORDS_PAGE_SEGMENTS,
    }).pipe(
      tap((answer) => {
        // A transcript newer than the open one: its words do not fit this text.
        const fits = keyOf(answer) === keyOf(transcript);
        const aligned = new Map<number, readonly PlacedWord[]>();
        for (const [segment, group] of groupBySegment(fits ? answer.words : []))
          aligned.set(segment, placed(segments[segment]?.text ?? '', group));
        if (this.key() === keyOf(transcript))
          this.pages.update((pages) => new Map(pages).set(page, aligned));
      }),
      // The caller reads `of`: what matters is that the wait is over.
      catchError(() => EMPTY),
      finalize(() => this.asking.delete(key)),
      share(),
    );
  }
}

const NO_WORDS: readonly PlacedWord[] = [];

const keyOf = ({
  mediaId,
  version,
  revision,
}: Pick<MediaTranscript, 'mediaId' | 'version' | 'revision'>): string =>
  `${mediaId}.${version}.${revision}`;

/** `alignWords` with each word's place and text: it keeps the non-empty ones, in order. */
function placed(
  text: string,
  words: readonly TranscriptWord[],
): readonly PlacedWord[] {
  const spoken = words.filter((word) => word.text !== '');
  return alignWords(text, spoken).map((word, index) => ({
    ...word,
    position: spoken[index]?.position ?? null,
    text: spoken[index]?.text ?? '',
  }));
}
