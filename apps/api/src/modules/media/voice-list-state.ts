import type { VoiceRevocations } from '../../ports/voice-revocation-list.js';

/** `unused`: no consent yet, so there is nothing to have lost and no need for a list. */
export type VoiceListState = 'unused' | 'whole' | 'lost' | 'exposed';

/**
 * Whether the list can vouch for the consents in the database (ADR 0032 §4). Only the two
 * together say so, and each time, so the order a disk and a backup come back in cannot matter:
 * a database with consents and no list, or with consents older than the list, has a past the
 * list did not see. The owner's own mark has no date: that is a person who checked.
 */
export function voiceListState(
  list: VoiceRevocations,
  oldestConsentAt: string | null,
): VoiceListState {
  if (!list.guarded) return 'exposed';
  if (oldestConsentAt === null) return list.complete ? 'whole' : 'unused';
  if (!list.complete) return 'lost';
  const youngerThanConsents =
    list.startedAt !== null && oldestConsentAt < list.startedAt;
  return youngerThanConsents ? 'lost' : 'whole';
}
