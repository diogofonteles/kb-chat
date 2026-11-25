import type { UploadedDocumentRef } from '@kb-chat/contracts';

/** Where the removed document is asked to be. */
export type RemovalWish = 'removed' | 'present';

/** The Mac that moves it now, and to where. */
export interface RemovalLease {
  readonly leaseId: string;
  readonly worker: string;
  readonly until: string;
  readonly wish: RemovalWish;
}

/** One document taken out of its collection in the app (KBC-187): kept until it is back. */
export interface RemovalRecord {
  readonly id: string;
  readonly topic: string;
  readonly document: UploadedDocumentRef;
  /** The level it had, for when it is back (ADR 0036 §5). */
  readonly level: string | null;
  readonly by: { readonly email: string; readonly name: string };
  readonly removedAt: string;
  /** What was asked last; the app hides it while it is `removed`. */
  readonly wish: RemovalWish;
  /** Where the Mac left it: in kb's quarantine, or still in the collection. */
  readonly isQuarantined: boolean;
  readonly lease: RemovalLease | null;
  readonly attempts: number;
  /** The Mac gave up: a person asks again. */
  readonly failed: boolean;
  readonly detail: string | null;
}

export interface RemovalStorePort {
  load(): Promise<readonly RemovalRecord[]>;
  save(records: readonly RemovalRecord[]): Promise<void>;
}
