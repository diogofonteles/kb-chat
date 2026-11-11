import type { LevelAuditEntry } from '@kb-chat/contracts';

/** Where a page of the audit stopped: the month's file and the line to read before (KBC-108). */
export interface LevelAuditPosition {
  /** `YYYY-MM`. */
  readonly month: string;
  /** Lines are read from the end: the next page reads the lines before this index. */
  readonly index: number;
}

/** A page of the audit, newest first (KBC-108 FR-4). */
export interface LevelAuditRead {
  readonly accepts: (entry: LevelAuditEntry) => boolean;
  /** The first and last months to read (`YYYY-MM`, inclusive). */
  readonly fromMonth?: string;
  readonly toMonth?: string;
  readonly after?: LevelAuditPosition;
  readonly limit: number;
}

export interface LevelAuditPage {
  readonly entries: readonly LevelAuditEntry[];
  readonly next: LevelAuditPosition | null;
}

/**
 * The levels audit (KBC-103 FR-10, ADR 0036 §11): append-only, every line written before
 * the answer leaves, kept 12 months like the act-as audit. Nothing rewrites a line.
 */
export interface LevelAuditPort {
  /**
   * One line. `freshLine` starts it on a line of its own, so it never joins a fragment a
   * failed append left (the `scale.undone` mark, KBC-108 R2-4).
   */
  append(
    entry: LevelAuditEntry,
    options?: { readonly freshLine?: boolean },
  ): Promise<void>;
  /** Several lines in one write and one sync (a bulk and its documents, KBC-107 NFR-1). */
  appendMany(entries: readonly LevelAuditEntry[]): Promise<void>;
  /** "Histórico de níveis" (KBC-108): the lines a filter keeps, newest first. */
  read(query: LevelAuditRead): Promise<LevelAuditPage>;
}
