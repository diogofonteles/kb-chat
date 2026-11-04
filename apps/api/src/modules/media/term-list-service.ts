import {
  TERMS_TOKEN_LIMIT,
  normalizeTerms,
  type SaveTermsRequest,
  type TermList,
  type TermsUsage,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import { countPromptTokens } from './whisper-tokens.js';

export interface TermListServiceDeps {
  readonly transcripts: Pick<
    TranscriptStorePort,
    'currentTerms' | 'termVersions' | 'saveTerms'
  >;
  readonly now?: () => Date;
}

/** Who saves a version (BR-1); the name stays as it was that day. */
export interface TermAuthor {
  readonly principal: string;
  readonly name: string | null;
}

const changed = (version: number) =>
  new AppError('MEDIA_CONFLICT', 'The term list changed meanwhile', {
    details: { reason: 'terms-changed', version },
  });

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((term, index) => term === b[index]);

/**
 * "Termos da transcrição" (KBC-040): masters change the one list, a version at a time. A new
 * version reaches the transcriber's next job and nothing else: no transcript is redone.
 */
export class TermListService {
  private readonly now: () => Date;

  constructor(private readonly deps: TermListServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  list(): TermList {
    const { transcripts } = this.deps;
    const current = transcripts.currentTerms();
    const versions = transcripts.termVersions();
    const newest = versions[0];
    if (!newest) throw new Error('the term list has no version');
    return {
      ...current,
      ...this.measure(current.terms),
      createdAt: newest.createdAt,
      authorName: newest.authorName,
      versions,
    };
  }

  measure(terms: readonly string[]): TermsUsage {
    return {
      tokens: countPromptTokens(normalizeTerms(terms)),
      limit: TERMS_TOKEN_LIMIT,
    };
  }

  /** The whole list, on the version the person edited (BR-1, BR-2). */
  save(request: SaveTermsRequest, author: TermAuthor): TermList {
    const terms = normalizeTerms(request.terms);
    const { transcripts } = this.deps;
    const current = transcripts.currentTerms();
    if (current.version !== request.baseVersion) throw changed(current.version);
    if (sameList(terms, current.terms)) return this.list();
    this.assertWithinLimit(terms);
    const saved = transcripts.saveTerms({
      baseVersion: request.baseVersion,
      terms,
      author,
      now: this.now(),
    });
    if (!saved) throw changed(transcripts.currentTerms().version);
    return this.list();
  }

  private assertWithinLimit(terms: readonly string[]): void {
    const usage = this.measure(terms);
    if (usage.tokens > usage.limit)
      throw new AppError('TERMS_OVER_LIMIT', 'The list passes the limit', {
        details: usage,
      });
  }
}
