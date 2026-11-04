import type { LegacyAuthorship, MediaRecord } from '../../ports/media-store.js';
import type { MediaActor } from './media-service.js';

/** The queue's timings and limits (ADR 0022 §2, KBC-034 BR-5). */

/** One lease plus three new attempts; the fourth failure gives the job up. */
export const MAX_JOB_ATTEMPTS = 4;
/** A worker heartbeats every 15 s; four missed beats lose the lease. */
export const JOB_LEASE_MS = 60_000;
export const JANITOR_INTERVAL_MS = 30_000;
/** An upload that never finished is given up after a day. */
export const UPLOAD_ABANDON_MS = 24 * 60 * 60 * 1000;
/** The converted audio (ADR 0022 §4: AAC in MP4). */
export const AUDIO_MIME = 'audio/mp4';

/** The author the pre-KBC-049 column means by `mestre-laercio` (ADR 0030 §4). */
const LEGACY_AUTHOR_SLUG = 'mestre-laercio';

/** The old image reads only this column: never name the Mestre for another author. */
export const legacyAuthorshipOf = (author: string | null): LegacyAuthorship =>
  author === LEGACY_AUTHOR_SLUG ? 'mestre-laercio' : 'outros-autores';

/** Who sent it, while they may still send, and any master (KBC-050 BR-1); a track follows its recording. */
export const canEditMedia = (
  actor: MediaActor,
  media: Pick<MediaRecord, 'ownerPrincipal' | 'track'>,
): boolean =>
  media.track === null &&
  (actor.isMaster ||
    (actor.canUpload && media.ownerPrincipal === actor.principal));
