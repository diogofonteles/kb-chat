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
    'currentTerms' | 'termPartsAt' | 'termVersions' | 'saveTerms'
  >;
  /** The learned terms that fit after the masters' (KBC-113 BR-9, ADR 0037 §5). */
  readonly learnedFor?: (manual: readonly string[]) => readonly string[];
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

  /** The masters' terms of a version: the learned ones are the learning's (BR-10). */
  private manualAt(version: number): readonly string[] | null {
    const parts = this.deps.transcripts.termPartsAt(version);
    return parts ? parts.manual : null;
  }

  list(): TermList {
    const { transcripts } = this.deps;
    const current = transcripts.currentTerms();
    const terms = [...(this.manualAt(current.version) ?? current.terms)];
    const versions = transcripts.termVersions();
    const newest = versions[0];
    if (!newest) throw new Error('the term list has no version');
    return {
      version: current.version,
      terms,
      ...this.measure(terms),
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

  /**
   * The masters' list, on the version the person edited (BR-1, BR-2). A version the learning
   * made since is no conflict; one with other masters' terms is (KBC-113 BR-10).
   */
  save(request: SaveTermsRequest, author: TermAuthor): TermList {
    const terms = normalizeTerms(request.terms);
    const { transcripts } = this.deps;
    const current = transcripts.currentTerms();
    const manual = this.manualAt(current.version) ?? current.terms;
    const base = this.manualAt(request.baseVersion);
    if (
      request.baseVersion > current.version ||
      !base ||
      !sameList(base, manual)
    )
      throw changed(current.version);
    if (sameList(terms, manual)) return this.list();
    this.assertWithinLimit(terms);
    const saved = transcripts.saveTerms({
      baseVersion: current.version,
      terms,
      learned: this.deps.learnedFor?.(terms) ?? [],
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
