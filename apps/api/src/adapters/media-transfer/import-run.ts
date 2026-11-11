import type { DatabaseSync } from 'node:sqlite';
import type { OpenedPackage } from './media-package.js';
import type { Collections } from './state-files.js';

/** Why a unit stays as it is in production, as the report says it (pt-BR, for the owner). */
export interface HeldUnit {
  readonly rootId: string;
  readonly title: string;
  readonly reason: string;
}

export interface UnassignedLevel {
  readonly mediaId: string;
  /** The Mac's level id and, when the package knows it, its code. */
  readonly level: string;
  readonly code: string | null;
}

export interface VerifyReport {
  readonly integrity: string;
  readonly foreignKeys: number;
  readonly indexRows: number;
  readonly indexExpected: number;
  /** Units edited in production since their import: not a failure, held if the Mac edits them too. */
  readonly ledgerMismatches: readonly string[];
  readonly missingFiles: readonly string[];
  readonly ok: boolean;
}

export interface ImportReport {
  readonly packageId: string;
  readonly dryRun: boolean;
  readonly inserted: string[];
  readonly updated: string[];
  readonly unchanged: string[];
  readonly held: HeldUnit[];
  readonly files: { copied: string[]; present: number; bytes: number };
  readonly people: {
    mapped: string[];
    unmapped: string[];
    skippedRows: number;
    rows: number;
  };
  readonly levels: { unassigned: UnassignedLevel[] };
  authorsAdded: readonly string[];
  termsAdded: number;
  switchesAdded: number;
  verify: VerifyReport | null;
}

/** Everything one run reads and writes, passed to each step. */
export interface ImportRun {
  readonly db: DatabaseSync;
  readonly pkg: OpenedPackage;
  readonly mediaDir: string;
  readonly collections: Collections;
  readonly scales: ReadonlyMap<string, ReadonlySet<string>>;
  readonly dryRun: boolean;
  readonly now: Date;
  readonly report: ImportReport;
}

/** One recording and its tracks, as the package has them. */
export interface SourceUnit {
  readonly rootId: string;
  readonly title: string;
  /** The recording first, then its tracks. */
  readonly media: readonly SourceMedia[];
  /** `JSON.stringify` of the ids, the `:ids` of every unit query. */
  readonly ids: string;
}

export interface SourceMedia {
  readonly id: string;
  readonly topic: string;
  readonly level: string | null;
}

export function emptyReport(packageId: string, dryRun: boolean): ImportReport {
  return {
    packageId,
    dryRun,
    inserted: [],
    updated: [],
    unchanged: [],
    held: [],
    files: { copied: [], present: 0, bytes: 0 },
    people: { mapped: [], unmapped: [], skippedRows: 0, rows: 0 },
    levels: { unassigned: [] },
    authorsAdded: [],
    termsAdded: 0,
    switchesAdded: 0,
    verify: null,
  };
}
