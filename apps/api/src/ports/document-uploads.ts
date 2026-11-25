import type { Readable } from 'node:stream';
import type {
  DocumentUploadFailure,
  DocumentUploadState,
  RecordingEntry,
  UploadedDocumentRef,
} from '@kb-chat/contracts';

/** Who sent a document, as the upload keeps them (KBC-149): their view at the moment of it. */
export interface UploadOwner {
  readonly principal: string;
  /** For the levels audit when the document arrives with its level. */
  readonly email: string;
  readonly isMaster: boolean;
  /** Their converted space for a recording link's audio; null: no quota (the owner). */
  readonly quotaBytes: number | null;
  readonly displayName: string | null;
}

/** A doc-ingest lease: who holds it and until when. */
export interface UploadLease {
  readonly leaseId: string;
  readonly worker: string;
  readonly until: string;
  /** What this lease may spend: held back from its inclusion's ceiling until it ends. */
  readonly budgetUsd: number;
}

/** The inclusion an item belongs to and its ceiling (KBC-009 R3), on each of its items. */
export interface UploadBatch {
  readonly id: string;
  readonly capUsd: number;
}

/** One document or link sent from the app, from its first byte to the collection (ADR 0040). */
export interface DocumentUploadRecord {
  readonly id: string;
  readonly topic: string;
  readonly kind: 'file' | 'url' | 'recording' | 'list';
  /** The file's name, or the link. */
  readonly name: string;
  readonly url: string | null;
  readonly sha256: string | null;
  readonly bytes: number | null;
  /** The level it is born at (ADR 0036 §5); null in a collection without levels. */
  readonly level: string | null;
  readonly owner: UploadOwner;
  readonly state: DocumentUploadState;
  readonly failure: DocumentUploadFailure | null;
  readonly detail: string | null;
  readonly document: UploadedDocumentRef | null;
  readonly mediaId: string | null;
  readonly lease: UploadLease | null;
  /** Null for an upload from before inclusions had a ceiling. */
  readonly batch: UploadBatch | null;
  /** Attempts the Mac spent on it (a crash or a lost lease counts; its own setup does not). */
  readonly attempts: number;
  readonly spentUsd: number;
  /** What a list holds, once the Mac read it and until the person chose. */
  readonly entries: readonly RecordingEntry[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Where the uploads' records live: read once at start, written whole after each change. */
export interface DocumentUploadStorePort {
  load(): Promise<readonly DocumentUploadRecord[]>;
  save(records: readonly DocumentUploadRecord[]): Promise<void>;
}

/** The bytes of a sent file, appended part by part (tus, ADR 0033), then kept until done. */
export interface DocumentUploadFilesPort {
  /** Bytes received so far (0 when none). */
  offset(id: string): Promise<number>;
  /** Appends a part, never past `maxBytes` in all; answers the new offset. */
  append(id: string, body: Readable, maxBytes: number): Promise<number>;
  sha256(id: string): Promise<string>;
  /** The file on disk, for the Mac's download; null when gone. */
  find(id: string): Promise<{ path: string; size: number } | null>;
  remove(id: string): Promise<void>;
}
