import { Injectable, computed, signal } from '@angular/core';
import {
  WEB_SEARCH_AUTHORS,
  WEB_SEARCH_KINDS,
  WEB_SEARCH_QUERY,
  WEB_SEARCH_SOURCES,
  authorsIn,
  sameAuthor,
  webSearchCredits,
  withoutQuotes,
  type WebSearchKind,
} from '@kb-chat/contracts';

/** Why a name was not added to the reference authors. */
export type AuthorProblem = 'short' | 'long' | 'repeated';

/**
 * What the person last asked the web search for (KBC-185): kept while the app is open, so
 * leaving the page and coming back finds it; never stored.
 */
@Injectable({ providedIn: 'root' })
export class WebSearchForm {
  private readonly subjectState = signal('');
  private readonly sourcesState = signal(String(WEB_SEARCH_SOURCES.default));
  private readonly kindsState =
    signal<readonly WebSearchKind[]>(WEB_SEARCH_KINDS);
  private readonly authorsState = signal<readonly string[]>([]);
  private readonly againState = signal(false);

  readonly subject = this.subjectState.asReadonly();
  /** As typed: it may be no number yet. */
  readonly sourcesText = this.sourcesState.asReadonly();
  readonly kinds = this.kindsState.asReadonly();
  readonly authors = this.authorsState.asReadonly();
  /** Also what was shown before and what the collection has. */
  readonly again = this.againState.asReadonly();

  readonly subjectValid = computed(
    () => this.subject().trim().length >= WEB_SEARCH_QUERY.min,
  );
  /** The sources wanted, as many as they are; null when what is typed is no whole number. */
  readonly sources = computed(() => {
    const text = this.sourcesText().trim();
    const sources = Number(text);
    const valid =
      text !== '' &&
      Number.isSafeInteger(sources) &&
      sources >= WEB_SEARCH_SOURCES.min;
    return valid ? sources : null;
  });
  /** About how many Firecrawl credits this would take. */
  readonly credits = computed(() =>
    webSearchCredits({
      sources: this.sources() ?? WEB_SEARCH_SOURCES.default,
      kinds: this.kinds().length,
      authors: this.authors().length,
    }),
  );

  setSubject(subject: string): void {
    this.subjectState.set(subject);
  }

  setSources(text: string): void {
    this.sourcesState.set(text);
  }

  setAgain(again: boolean): void {
    this.againState.set(again);
  }

  toggleKind(kind: WebSearchKind): void {
    this.kindsState.update((kinds) =>
      WEB_SEARCH_KINDS.filter((one) => (one === kind) !== kinds.includes(one)),
    );
  }

  /** Adds each name typed, separated by commas; or says why one was not, adding none. */
  addAuthors(typed: string): AuthorProblem | null {
    const added: string[] = [];
    const names = authorsIn(typed);
    if (names.length === 0) return 'short';
    for (const name of names) {
      const problem = this.problemOf(name, added);
      if (problem) return problem;
      added.push(name);
    }
    this.authorsState.update((authors) => [...authors, ...added]);
    return null;
  }

  private problemOf(
    name: string,
    added: readonly string[],
  ): AuthorProblem | null {
    const { nameMin, nameMax } = WEB_SEARCH_AUTHORS;
    const authors = [...this.authors(), ...added];
    if (withoutQuotes(name).length < nameMin) return 'short';
    if (name.length > nameMax) return 'long';
    return authors.some((one) => sameAuthor(one, name)) ? 'repeated' : null;
  }

  removeAuthor(name: string): void {
    this.authorsState.update((authors) =>
      authors.filter((one) => one !== name),
    );
  }
}
