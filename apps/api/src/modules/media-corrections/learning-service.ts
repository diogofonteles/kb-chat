import { randomUUID } from 'node:crypto';
import {
  TERMS_TOKEN_LIMIT,
  type LearnedExample,
  type LearnedRule,
  type TranscriptLearning,
  type TranscriptionTerms,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { TranscriptCorrectionStorePort } from '../../ports/transcript-correction-store.js';
import type { TranscriptStorePort } from '../../ports/transcript-store.js';
import { rowOf, writeChange } from './correction-writer.js';
import {
  LEARNING_NAME,
  LEARNING_PRINCIPAL,
  applyRules,
  deriveRules,
  learnedTerms,
  type LearnedTermRow,
  type LearningSource,
  type Rule,
  type RuleChange,
} from './learning-rules.js';

/** Examples a rule shows (FR-2). */
const EXAMPLES = 3;

export interface LearningServiceDeps {
  readonly corrections: TranscriptCorrectionStorePort;
  readonly transcripts: Pick<
    TranscriptStorePort,
    'currentTerms' | 'termPartsAt' | 'saveTerms'
  >;
  /** Whisper's prompt tokens of a list (KBC-040 BR-2). */
  readonly countTokens: (terms: readonly string[]) => number;
  readonly onApplied?: (event: {
    readonly mediaId: string;
    readonly rules: number;
  }) => void;
  readonly now?: () => Date;
  readonly newId?: () => string;
}

/** A master switching a rule or a term (BR-11). */
export interface LearningAuthor {
  readonly principal: string;
  readonly name: string | null;
}

const LEARNING_AUTHOR = { principal: LEARNING_PRINCIPAL, name: LEARNING_NAME };

const unknownItem = () =>
  new AppError('NOT_FOUND', 'Nothing learned with this id');

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((term, index) => term === b[index]);

function exampleOf(source: LearningSource): LearnedExample {
  return {
    mediaId: source.mediaId,
    title: source.mediaTitle,
    startMs: source.startMs,
    before: source.before.filter((text) => text !== '').join(' '),
    after: source.after,
    contextBefore: source.contextBefore,
    contextAfter: source.contextAfter,
    authorName: source.authorName,
    createdAt: source.createdAt,
  };
}

function toContract(rule: Rule): LearnedRule {
  return {
    id: rule.id,
    before: rule.before,
    after: rule.after,
    contextBefore: rule.contextBefore,
    contextAfter: rule.contextAfter,
    corrections: rule.corrections,
    recordings: rule.recordings,
    applied: rule.applied,
    undone: rule.undone,
    state: rule.state,
    switchedBy: rule.switchedBy,
    conflictWith: rule.conflictWith,
    examples: rule.sources.slice(0, EXAMPLES).map(exampleOf),
  };
}

/**
 * Learning from word corrections (KBC-113, ADR 0037): rules derived from the corrections in
 * force, applied to a recording's new version inside its transaction; learned terms appended
 * to the transcriber's list; masters see and switch both.
 */
export class LearningService {
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly deps: LearningServiceDeps) {
    this.now = deps.now ?? (() => new Date());
    this.newId = deps.newId ?? randomUUID;
  }

  private rules(): Rule[] {
    const { corrections } = this.deps;
    return deriveRules(corrections.learningSources(), {
      tallies: corrections.ruleTallies(),
      switches: corrections.switches(),
    });
  }

  /**
   * Inside the new version's transaction, after the carry-over and before the tracks are cut
   * (FR-1, BR-6): every enabled rule that matches, one revision, one group per rule.
   */
  apply(mediaId: string): void {
    const { corrections: store } = this.deps;
    const current = store.current(mediaId);
    if (!current) return;
    const changes = applyRules(
      store.allWords(current.id),
      this.rules(),
      store.carriedPositions(current.id),
    );
    const meta = {
      kind: 'correct' as const,
      revision: current.revision + 1,
      author: LEARNING_AUTHOR,
      at: this.now().toISOString(),
    };
    const groups = new Map<string, string>();
    for (const change of changes) {
      if (!this.written(current.id, change)) continue;
      const groupId = groups.get(change.rule.id) ?? this.newId();
      groups.set(change.rule.id, groupId);
      const id = this.newId();
      const ruleId = change.rule.id;
      store.insert(rowOf(current, change, { ...meta, id, groupId, ruleId }));
    }
    if (groups.size === 0) return;
    store.setRevision(current.id, meta.revision);
    this.deps.onApplied?.({ mediaId, rules: groups.size });
  }

  /**
   * Writes a replacement; false when its segment cannot be rewritten (409 `not-aligned`):
   * it is skipped and never fails the new version (ADR 0034 §6, ADR 0037 §2).
   */
  private written(transcriptId: string, change: RuleChange): boolean {
    try {
      writeChange(this.deps.corrections, transcriptId, change);
      return true;
    } catch (err) {
      if (err instanceof AppError && err.code === 'CORRECTION_CONFLICT')
        return false;
      throw err;
    }
  }

  /** What masters see (FR-2). */
  overview(): TranscriptLearning {
    const manual = this.manualTerms();
    const terms = this.terms(manual);
    const inList = terms
      .filter((term) => term.state === 'in-list')
      .map((term) => term.term);
    const manualTokens = this.deps.countTokens(manual);
    return {
      rules: this.rules().map(toContract),
      terms: terms.map(
        ({ id, term, corrections, recordings, state, switchedBy }) => ({
          id,
          term,
          corrections,
          recordings,
          state,
          switchedBy,
        }),
      ),
      tokens: {
        manual: manualTokens,
        learned:
          inList.length === 0
            ? 0
            : this.deps.countTokens([...manual, ...inList]) - manualTokens,
        limit: TERMS_TOKEN_LIMIT,
      },
    };
  }

  /** A master's on/off, or back to automatic with null (FR-3, BR-11). */
  switchRule(id: string, enabled: boolean | null, author: LearningAuthor) {
    if (!this.rules().some((rule) => rule.id === id)) throw unknownItem();
    return this.switch({ kind: 'rule', key: id, enabled, author });
  }

  switchTerm(id: string, enabled: boolean | null, author: LearningAuthor) {
    const known = this.terms(this.manualTerms()).some((term) => term.id === id);
    if (!known) throw unknownItem();
    return this.switch({ kind: 'term', key: id, enabled, author });
  }

  private switch(input: {
    readonly kind: 'rule' | 'term';
    readonly key: string;
    readonly enabled: boolean | null;
    readonly author: LearningAuthor;
  }): TranscriptLearning {
    this.deps.corrections.setSwitch({ ...input, now: this.now() });
    return this.overview();
  }

  /**
   * The list the transcriber is prompted with (FR-4, BR-10): the masters' terms and the
   * learned ones that fit; a new version, by the learning, only when the learned part changed.
   */
  termsForTranscriber(): TranscriptionTerms {
    const { corrections, transcripts } = this.deps;
    return corrections.inTransaction(() => {
      const current = transcripts.currentTerms();
      const parts = transcripts.termPartsAt(current.version);
      const manual = parts?.manual ?? current.terms;
      const learned = this.learnedFor(manual);
      if (sameList(learned, parts?.learned ?? [])) return current;
      transcripts.saveTerms({
        baseVersion: current.version,
        terms: manual,
        learned,
        author: LEARNING_AUTHOR,
        now: this.now(),
      });
      return transcripts.currentTerms();
    });
  }

  /** The learned terms that fit after `manual` (BR-9), as the list will carry them. */
  learnedFor(manual: readonly string[]): string[] {
    return this.terms(manual)
      .filter((term) => term.state === 'in-list')
      .map((term) => term.term);
  }

  private manualTerms(): readonly string[] {
    const { transcripts } = this.deps;
    const current = transcripts.currentTerms();
    return transcripts.termPartsAt(current.version)?.manual ?? current.terms;
  }

  private terms(manual: readonly string[]): LearnedTermRow[] {
    const { corrections, countTokens } = this.deps;
    return learnedTerms(corrections.learningSources(), {
      manual,
      fits: (list) => countTokens(list) <= TERMS_TOKEN_LIMIT,
      switches: corrections.switches(),
    });
  }
}
