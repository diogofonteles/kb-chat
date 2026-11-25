import { Injectable, computed, signal } from '@angular/core';
import {
  WEB_SEARCH_AUTHORS,
  WEB_SEARCH_KINDS,
  WEB_SEARCH_QUERY,
  WEB_SEARCH_SOURCES,
  sameAuthor,
  webSearchCalls,
  withoutQuotes,
  type WebSearchKind,
} from '@kb-chat/contracts';

/** Why a name was not added to the reference authors. */
export type AuthorProblem = 'short' | 'repeated' | 'full';

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

  readonly subject = this.subjectState.asReadonly();
  /** As typed: it may be no number yet. */
  readonly sourcesText = this.sourcesState.asReadonly();
  readonly kinds = this.kindsState.asReadonly();
  readonly authors = this.authorsState.asReadonly();

  readonly subjectValid = computed(
    () => this.subject().trim().length >= WEB_SEARCH_QUERY.min,
  );
  /** The sources wanted, or null when what is typed is not from 1 to 30. */
  readonly sources = computed(() => {
    const text = this.sourcesText().trim();
    const sources = Number(text);
    const { min, max } = WEB_SEARCH_SOURCES;
    const valid =
      text !== '' &&
      Number.isInteger(sources) &&
      sources >= min &&
      sources <= max;
    return valid ? sources : null;
  });
  /** Firecrawl searches this would make. */
  readonly calls = computed(() =>
    webSearchCalls(this.kinds().length, this.authors().length),
  );

  setSubject(subject: string): void {
    this.subjectState.set(subject);
  }

  setSources(text: string): void {
    this.sourcesState.set(text);
  }

  toggleKind(kind: WebSearchKind): void {
    this.kindsState.update((kinds) =>
      WEB_SEARCH_KINDS.filter((one) => (one === kind) !== kinds.includes(one)),
    );
  }

  /** Adds a name, or says why not. */
  addAuthor(typed: string): AuthorProblem | null {
    const name = typed.replace(/\s+/g, ' ').trim();
    const authors = this.authors();
    if (withoutQuotes(name).length < WEB_SEARCH_AUTHORS.nameMin) return 'short';
    if (authors.some((one) => sameAuthor(one, name))) return 'repeated';
    if (authors.length >= WEB_SEARCH_AUTHORS.max) return 'full';
    this.authorsState.set([...authors, name]);
    return null;
  }

  removeAuthor(name: string): void {
    this.authorsState.update((authors) =>
      authors.filter((one) => one !== name),
    );
  }
}
