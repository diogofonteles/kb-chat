import type { MediaJobKind } from '@kb-chat/contracts';

/** The worker name a paired transcriber's leases carry: tied to its token, never to a body. */
export const TRANSCRIBER_LEASE_PREFIX = 'transcriber:';
export const leaseNameOf = (transcriberId: string): string =>
  `${TRANSCRIBER_LEASE_PREFIX}${transcriberId}`;

/** A paired worker (ADR 0023 §2); the token itself is never stored. */
export interface TranscriberRecord {
  readonly id: string;
  readonly name: string;
  readonly kinds: readonly MediaJobKind[];
  readonly createdAt: string;
  readonly lastSeenAt: string | null;
  /** The item whose job it holds now. */
  readonly currentJob: {
    readonly mediaId: string;
    readonly title: string;
    readonly kind: MediaJobKind;
  } | null;
}

export interface NewTranscriber {
  readonly id: string;
  readonly name: string;
  readonly kinds: readonly MediaJobKind[];
  /** The keyed hash of its token. */
  readonly tokenHash: string;
  /** The master who paired it. */
  readonly createdBy: string;
  readonly now: Date;
}

/** Paired transcribers, in the media database; revoked ones are kept but never listed. */
export interface TranscriberStorePort {
  pair(transcriber: NewTranscriber): TranscriberRecord;
  /** The ones not revoked, oldest first. */
  list(): TranscriberRecord[];
  /** The one not revoked whose token has this hash. */
  byTokenHash(tokenHash: string): TranscriberRecord | null;
  /** It was just heard from. */
  touch(input: { readonly id: string; readonly now: Date }): void;
  /** What it may lease from now on (FR-6); null when unknown or revoked. */
  setKinds(input: {
    readonly id: string;
    readonly kinds: readonly MediaJobKind[];
  }): TranscriberRecord | null;
  /** Revokes it and gives its leased jobs back to the queue; false when unknown. */
  revoke(input: { readonly id: string; readonly now: Date }): boolean;
}
