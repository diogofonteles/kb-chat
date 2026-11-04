import type {
  VoiceConsent,
  VoiceConsentEntry,
  VoiceProfile,
} from '@kb-chat/contracts';
import type { JobStatus, LeaseOwner } from './media-store.js';

/** The proof of a consent, as stored: its content sealed (ADR 0017). */
export interface SealedEvidence {
  readonly kind: 'text' | 'attachment';
  readonly fileName: string | null;
  readonly mime: string | null;
  readonly sealed: string;
}

export interface VoiceProfileSource {
  readonly diarizationId: string;
  readonly voice: number;
}

/** A consent and its profile, stored together: there is no profile without one (BR-1). */
export interface NewVoiceProfile {
  readonly profileId: string;
  readonly consentId: string;
  readonly jobId: string;
  /** The top-level collection (BR-4). */
  readonly collection: string;
  readonly speakerId: string;
  readonly speakerName: string;
  readonly consent: Omit<VoiceConsent, 'evidence'>;
  readonly evidence: SealedEvidence;
  readonly sources: readonly VoiceProfileSource[];
  /** The recording the job hangs from (a job belongs to one item). */
  readonly jobMediaId: string;
  readonly registeredBy: string;
  readonly now: Date;
}

/** A profile as stored: never the print. */
export interface StoredVoiceProfile extends Omit<
  VoiceProfile,
  'status' | 'speakerName'
> {
  readonly speakerName: string;
  readonly collection: string;
  /** Set once the print is stored. */
  readonly model: string | null;
  /** The newest job's status; null when it went (with the recording it hung from). */
  readonly jobStatus: JobStatus | null;
}

/** A voice a person named as a speaker, on the newest separation of a recording. */
export interface StoredNamedVoice extends VoiceProfileSource {
  readonly mediaId: string;
  readonly title: string;
  readonly topic: string;
  readonly speakingMs: number;
}

/** A suggestion waiting for a person (FR-3). */
export interface PendingSuggestion {
  readonly voice: number;
  readonly speakerId: string;
  readonly collection: string;
  readonly similarity: number;
}

/** Consents, profiles and suggestions in the media database; prints never (ADR 0032). */
export interface VoiceProfileStorePort {
  /** False when the speaker already has a profile. */
  create(profile: NewVoiceProfile): boolean;
  get(id: string): StoredVoiceProfile | null;
  list(collection: string): StoredVoiceProfile[];
  /** Every profile id, for the prints that lost theirs. */
  ids(): string[];
  /** When the oldest consent was registered, revoked or not; null when there is none. */
  oldestConsentAt(): string | null;
  /** The profile of each revoked consent: all of them must be on the revocation list. */
  revokedProfileIds(): string[];
  /** Queues the print again; false when a job waits or runs, or nothing is left to use. */
  recalculate(input: {
    readonly profileId: string;
    readonly jobId: string;
    readonly now: Date;
  }): boolean;
  /**
   * In one transaction: the consent is marked revoked, and the profile, its sources, its job
   * and its suggestions go. Confirmed names are labels, and stay (BR-2).
   */
  revoke(input: {
    readonly profileId: string;
    readonly by: string;
    readonly now: Date;
  }): boolean;
  namedVoices(speakerId: string): StoredNamedVoice[];
  sourcesOf(profileId: string): (VoiceProfileSource & {
    readonly mediaId: string;
  })[];
  /** The profile of the `voice-profile` job the owner holds; null when it holds none. */
  heldProfile(owner: LeaseOwner): string | null;
  /** Closes the lease and marks the print as stored; false when the lease is gone. */
  completePrint(input: {
    readonly owner: LeaseOwner;
    readonly model: string;
    readonly now: Date;
  }): boolean;
  /** The profile a job calculates; null for any other job. */
  profileOfJob(jobId: string): string | null;
  /** Profiles with a stored print in a collection. */
  readyProfiles(collection: string): StoredVoiceProfile[];
  /** Stores the suggestions of a separation; a profile revoked meanwhile is skipped. */
  addSuggestions(input: {
    readonly diarizationId: string;
    readonly suggestions: readonly {
      readonly voice: number;
      readonly profileId: string;
      readonly similarity: number;
    }[];
  }): void;
  pendingSuggestions(diarizationId: string): PendingSuggestion[];
  /** A person's answer; false when there is no pending suggestion for that voice. */
  decide(input: {
    readonly diarizationId: string;
    readonly voice: number;
    readonly status: 'accepted' | 'refused';
    readonly by: string;
    readonly now: Date;
  }): boolean;
  report(): VoiceConsentEntry[];
  evidence(consentId: string): SealedEvidence | null;
}
