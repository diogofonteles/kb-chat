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

type PageWords = ReadonlyMap<number, readonly SpokenWord[]>;

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
  private readonly transcriptKey = computed(() => {
    const { mediaId, version } = this.transcript();
    return `${mediaId}.${version}`;
  });
  private readonly pages = linkedSignal<string, ReadonlyMap<number, PageWords>>(
    {
      source: this.transcriptKey,
      computation: () => new Map(),
    },
  );
  private readonly asking = new Map<string, Observable<unknown>>();

  constructor(
    private readonly transcript: Signal<MediaTranscript>,
    private readonly askForWords: AskForWords,
  ) {}

  /** A segment's words; empty without word times; null while its page is not here. */
  of(segment: number): readonly SpokenWord[] | null {
    const page = this.pages().get(wordsPageOf(segment));
    return page ? (page.get(segment) ?? NO_WORDS) : null;
  }

  /** Brings a page in; completes without a value when it cannot be had. */
  load(page: number): Observable<unknown> {
    if (this.pages().has(page)) return of(page);
    const key = `${this.transcriptKey()}.${page}`;
    const asked = this.asking.get(key) ?? this.ask(page, key);
    this.asking.set(key, asked);
    return asked;
  }

  private ask(page: number, key: string): Observable<unknown> {
    const { mediaId, version, segments } = this.transcript();
    return this.askForWords(mediaId, {
      from: page * WORDS_PAGE_SEGMENTS,
      count: WORDS_PAGE_SEGMENTS,
    }).pipe(
      tap((answer) => {
        // A transcript newer than the open one: its words do not fit this text.
        const words = answer.version === version ? answer.words : [];
        const aligned = new Map<number, readonly SpokenWord[]>();
        for (const [segment, group] of groupBySegment(words))
          aligned.set(
            segment,
            alignWords(segments[segment]?.text ?? '', group),
          );
        if (this.transcriptKey() === `${mediaId}.${version}`)
          this.pages.update((pages) => new Map(pages).set(page, aligned));
      }),
      // The caller reads `of`: what matters is that the wait is over.
      catchError(() => EMPTY),
      finalize(() => this.asking.delete(key)),
      share(),
    );
  }
}

const NO_WORDS: readonly SpokenWord[] = [];
