import type { LevelAuditEntry } from '@kb-chat/contracts';

/**
 * The levels audit (KBC-103 FR-10, ADR 0036 §11): append-only, every line written before
 * the answer leaves, kept 12 months like the act-as audit. Nothing rewrites a line.
 */
export interface LevelAuditPort {
  append(entry: LevelAuditEntry): Promise<void>;
  /** Several lines in one write and one sync (a bulk and its documents, KBC-107 NFR-1). */
  appendMany(entries: readonly LevelAuditEntry[]): Promise<void>;
}
