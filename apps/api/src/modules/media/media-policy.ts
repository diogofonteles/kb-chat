import { MEDIA_AUDIO_BYTES_PER_HOUR } from '@kb-chat/contracts';
import type { LegacyAuthorship, MediaRecord } from '../../ports/media-store.js';
import type { MediaActor } from './media-service.js';

/** The queue's timings and limits (ADR 0022 §2, KBC-034 BR-5). */

/** One lease plus three new attempts; the fourth failure gives the job up. */
export const MAX_JOB_ATTEMPTS = 4;
/** A worker heartbeats every 15 s; four missed beats lose the lease. */
export const JOB_LEASE_MS = 60_000;
export const JANITOR_INTERVAL_MS = 30_000;
/** An upload with no new part for a day is given up (KBC-035 BR-3). */
export const UPLOAD_ABANDON_MS = 24 * 60 * 60 * 1000;
/** The converted audio (ADR 0022 §4: AAC in MP4). */
export const AUDIO_MIME = 'audio/mp4';

/**
 * What a file should take once converted (KBC-035 FR-3): 30 MB per hour, or the file's own
 * size when the browser could not read its length.
 */
export const estimatedBytesOf = (input: {
  readonly bytes: number;
  readonly durationMs?: number | null;
}): number =>
  input.durationMs
    ? Math.ceil((input.durationMs / 3_600_000) * MEDIA_AUDIO_BYTES_PER_HOUR)
    : input.bytes;

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

/** What decides whether a person sees an audio: where it is, its level and whether it is a track. */
export interface LevelledMedia {
  readonly topic: string;
  readonly level: string | null;
  readonly isTrack: boolean;
}

/**
 * The visibility rule of media (ADR 0036 §6, KBC-105 BR-5, BR-8): the collection must be one
 * the person sees and, in a collection with levels, the audio must hold one of the levels
 * the person sees; one with none ("Sem nível") is for masters only. A track's own level is
 * KBC-106: until then, tracks stay closed to members in a collection with levels.
 */
export function seesLevelled(actor: MediaActor, media: LevelledMedia): boolean {
  if (!actor.canSee(media.topic)) return false;
  const allowed = actor.levelsIn(media.topic);
  if (allowed === null) return true;
  if (media.isTrack) return false;
  return media.level !== null && allowed.includes(media.level);
}

/** `seesLevelled` for a stored item. */
export const seesMedia = (
  actor: MediaActor,
  media: Pick<MediaRecord, 'topic' | 'level' | 'track'>,
): boolean =>
  seesLevelled(actor, {
    topic: media.topic,
    level: media.level,
    isTrack: media.track !== null,
  });

/** The tracks of a collection reach this person: no levels hold them there (KBC-106). */
export const seesTracksIn = (actor: MediaActor, topic: string): boolean =>
  actor.canSee(topic) && actor.levelsIn(topic) === null;
