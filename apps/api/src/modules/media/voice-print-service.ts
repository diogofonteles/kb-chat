import {
  VOICE_MATCH_THRESHOLD,
  similarityLevelOf,
  type CompleteVoicePrintRequest,
  type VoiceProfileJob,
  type VoiceProfileSuggestion,
  type WorkerVoiceProfiles,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { DiarizationStorePort } from '../../ports/diarization-store.js';
import type {
  LeaseOwner,
  LeasedJob,
  MediaRecord,
  MediaStorePort,
} from '../../ports/media-store.js';
import type {
  SpeakerStorePort,
  VoiceLabelStorePort,
} from '../../ports/speaker-store.js';
import type { VoicePrintVaultPort } from '../../ports/voice-print-vault.js';
import type {
  VoiceProfileSource,
  VoiceProfileStorePort,
} from '../../ports/voice-profile-store.js';
import { JOB_LEASE_MS } from './media-policy.js';
import {
  aliasOf,
  mergeTurns,
  toCollectionSpeaker,
  type AuthorLookup,
} from './voice-labels.js';

export interface VoicePrintServiceDeps {
  readonly profiles: VoiceProfileStorePort;
  readonly prints: VoicePrintVaultPort;
  readonly store: MediaStorePort;
  readonly diarizations: DiarizationStorePort;
  readonly voiceLabels: VoiceLabelStorePort;
  readonly speakers: SpeakerStorePort;
  readonly rootOf: (topic: string) => string;
  readonly authorOf: AuthorLookup;
  readonly now?: () => Date;
}

/** A match from the Mac, its voice already numbered as the separation's. */
export interface NumberedMatch {
  readonly voice: number;
  readonly profileId: string;
  readonly similarity: number;
}

const leaseLost = () =>
  new AppError('MEDIA_CONFLICT', 'This lease is no longer yours');
const notYours = () => new AppError('NOT_FOUND', 'No such job for this worker');

/**
 * Voice prints and the transcriber (KBC-071 FR-2, FR-3, ADR 0032). This is the only code that
 * reads a print out of the vault, and it hands it only to the lease of a job on the same
 * collection (BR-4, BR-5). The browser gets names, never a print or a score.
 */
export class VoicePrintService {
  private readonly now: () => Date;

  constructor(private readonly deps: VoicePrintServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** What a leased `voice-profile` job needs: each recording and the voice's turns in it. */
  jobOf(job: LeasedJob): VoiceProfileJob {
    const profileId = this.deps.profiles.profileOfJob(job.id);
    const sources = profileId ? this.deps.profiles.sourcesOf(profileId) : [];
    return {
      id: job.id,
      leaseId: job.leaseId,
      kind: 'voice-profile',
      mediaId: job.mediaId,
      attempt: job.attempt,
      leaseMs: JOB_LEASE_MS,
      sources: sources.map((source) => ({
        audioPath: `/api/v1/media-worker/jobs/${job.id}/audio/${source.mediaId}`,
        spans: this.spansOf(source),
      })),
    };
  }

  /** Whether the job this owner holds uses that recording's audio. */
  usesMedia(owner: LeaseOwner, mediaId: string): boolean {
    const profileId = this.deps.profiles.heldProfile(owner);
    if (!profileId) return false;
    return this.deps.profiles
      .sourcesOf(profileId)
      .some((source) => source.mediaId === mediaId);
  }

  /**
   * The print goes to the vault, then the lease closes: a profile revoked meanwhile has no
   * job, so the lease is gone and the print is removed again (BR-2).
   */
  async complete(
    owner: LeaseOwner,
    done: CompleteVoicePrintRequest,
  ): Promise<void> {
    const profileId = this.deps.profiles.heldProfile(owner);
    if (!profileId) throw leaseLost();
    await this.deps.prints.put(profileId, done.embedding);
    const stored = this.deps.profiles.completePrint({
      owner,
      model: done.model,
      now: this.now(),
    });
    if (stored) return;
    await this.deps.prints.remove(profileId);
    throw leaseLost();
  }

  /** The prints of the collection of the separation this owner holds; none is 200 and []. */
  async printsFor(owner: LeaseOwner): Promise<WorkerVoiceProfiles> {
    const held = this.deps.diarizations.heldDiarization(owner);
    const media = held && this.deps.store.getMedia(held.mediaId);
    if (!media) throw notYours();
    const ready = this.deps.profiles.readyProfiles(
      this.deps.rootOf(media.topic),
    );
    const read = await Promise.all(
      ready.map(async ({ id, model }) => {
        const embedding = await this.deps.prints.read(id);
        return embedding && model ? [{ id, model, embedding }] : [];
      }),
    );
    return { profiles: read.flat() };
  }

  /**
   * What the Mac found, kept above the threshold only (BR-3) and only for a profile of this
   * recording's collection (BR-4): anything else is dropped, whatever the worker sent.
   */
  recordMatches(input: {
    readonly media: MediaRecord;
    readonly diarizationId: string;
    readonly matches: readonly NumberedMatch[];
  }): void {
    const collection = this.deps.rootOf(input.media.topic);
    const known = new Set(
      this.deps.profiles.readyProfiles(collection).map(({ id }) => id),
    );
    this.deps.profiles.addSuggestions({
      diarizationId: input.diarizationId,
      suggestions: input.matches.filter(
        ({ profileId, similarity }) =>
          similarity >= VOICE_MATCH_THRESHOLD && known.has(profileId),
      ),
    });
  }

  /**
   * The suggestions to show for `voices`, the voices with no name yet. A recording moved to
   * another collection stops showing the old one's profiles (BR-4).
   */
  suggestions(input: {
    readonly media: MediaRecord;
    readonly diarizationId: string;
    readonly voices: readonly number[];
  }): VoiceProfileSuggestion[] {
    const collection = this.deps.rootOf(input.media.topic);
    return this.deps.profiles
      .pendingSuggestions(input.diarizationId)
      .filter(
        (one) =>
          one.collection === collection && input.voices.includes(one.voice),
      )
      .flatMap((one) => {
        const speaker = this.deps.speakers.get(one.speakerId);
        if (!speaker) return [];
        const { name } = toCollectionSpeaker(speaker, this.deps.authorOf);
        const level = similarityLevelOf(one.similarity);
        return [{ voice: one.voice, speakerId: one.speakerId, name, level }];
      });
  }

  /** The turns of a source voice, with the voices a person joined to it. */
  private spansOf(source: VoiceProfileSource) {
    const { diarizations, voiceLabels } = this.deps;
    const labels = voiceLabels.labels(source.diarizationId);
    return mergeTurns(diarizations.turns(source.diarizationId), aliasOf(labels))
      .filter((turn) => turn.voice === source.voice)
      .map(({ startMs, endMs }) => ({ startMs, endMs }));
  }
}
