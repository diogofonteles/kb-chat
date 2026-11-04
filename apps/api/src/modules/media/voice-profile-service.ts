import { randomUUID } from 'node:crypto';
import {
  MAX_CONSENT_ATTACHMENT_BYTES,
  MIN_PROFILE_SPEECH_MS,
  voiceConsentSchema,
  type CreateVoiceProfileRequest,
  type NamedVoice,
  type VoiceConsent,
  type VoiceConsentEntry,
  type VoiceConsentEvidence,
  type VoiceProfile,
  type VoiceProfileList,
  type VoiceProfileStatus,
  type VoiceSource,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { JobStatus, MediaStorePort } from '../../ports/media-store.js';
import type { SecretSealerPort } from '../../ports/secret-sealer.js';
import type {
  SpeakerStorePort,
  StoredSpeaker,
} from '../../ports/speaker-store.js';
import type { VoicePrintVaultPort } from '../../ports/voice-print-vault.js';
import type {
  SealedEvidence,
  StoredNamedVoice,
  StoredVoiceProfile,
  VoiceProfileStorePort,
} from '../../ports/voice-profile-store.js';
import type { VoiceRevocationListPort } from '../../ports/voice-revocation-list.js';
import type { Presence } from './transcriber-service.js';
import { toCollectionSpeaker, type AuthorLookup } from './voice-labels.js';

export interface VoiceProfileServiceDeps {
  readonly profiles: VoiceProfileStorePort;
  readonly prints: VoicePrintVaultPort;
  /** Who revoked, out of reach of a restored database (ADR 0032). */
  readonly revocations: VoiceRevocationListPort;
  readonly speakers: SpeakerStorePort;
  readonly store: MediaStorePort;
  /** Seals the proof of each consent (ADR 0017). */
  readonly sealer: SecretSealerPort;
  readonly rootOf: (topic: string) => string;
  readonly authorOf: AuthorLookup;
  /** Whether a transcriber marked for voice profiles is on. */
  readonly presence: () => Presence;
  readonly now?: () => Date;
}

/** Who acts, and whether they see the collection (masters do, unless they act as someone). */
export interface VoiceProfileActor {
  readonly email: string;
  readonly canSee: (topic: string) => boolean;
}

/** The document of a consent, ready to be downloaded. */
export interface ConsentDocument {
  readonly mime: string;
  readonly data: Buffer;
  readonly extension: string;
}

const EXTENSIONS: Readonly<Record<string, string>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};
const TEXT_MIME = 'text/plain; charset=utf-8';

const contextOf = (consentId: string): string => `voice-consent:${consentId}`;
const notFound = () => new AppError('NOT_FOUND', 'Unknown voice profile');
const invalidSources = () =>
  new AppError('VALIDATION_FAILED', 'These voices cannot make this profile', {
    details: { field: 'sources' },
  });

const JOB_RUNNING: readonly (JobStatus | null)[] = ['queued', 'leased'];

/** Today, as a date, in UTC. */
const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Voice profiles for people (KBC-071, ADR 0032): a profile exists only with a consent
 * recorded first (BR-1), and revoking deletes its print before anything else (BR-2). Who may
 * do this is in the routes: the master role and a grant by name.
 */
export class VoiceProfileService {
  private readonly now: () => Date;

  constructor(private readonly deps: VoiceProfileServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async list(topic: string): Promise<VoiceProfileList> {
    const stored = this.deps.profiles.list(this.deps.rootOf(topic));
    const items = await Promise.all(stored.map((one) => this.toView(one)));
    const presence = this.deps.presence();
    return { items, transcriber: presence.transcriber };
  }

  /** The voices a person named as this speaker, in this collection's recordings. */
  namedVoices(topic: string, speakerId: string): NamedVoice[] {
    this.speakerOf(this.deps.rootOf(topic), speakerId);
    return this.voicesOf(topic, speakerId).map(
      ({ mediaId, title, voice, speakingMs }) => ({
        mediaId,
        title,
        voice,
        speakingMs,
      }),
    );
  }

  /** The consent first: nothing else of the request counts without it (FR-1, AC-1). */
  async create(
    target: { readonly topic: string; readonly by: string },
    request: CreateVoiceProfileRequest,
  ): Promise<VoiceProfile> {
    const consent = this.consentOf(request.consent);
    await this.assertMayPrint();
    const collection = this.deps.rootOf(target.topic);
    const speaker = this.speakerOf(collection, request.speakerId);
    const sources = this.resolveSources(target.topic, request);
    const [first] = sources;
    if (!first) throw invalidSources();
    const consentId = randomUUID();
    const profileId = randomUUID();
    const created = this.deps.profiles.create({
      profileId,
      consentId,
      jobId: randomUUID(),
      collection,
      speakerId: speaker.id,
      speakerName: toCollectionSpeaker(speaker, this.deps.authorOf).name,
      consent,
      evidence: this.sealEvidence(consentId, consent.evidence),
      sources,
      jobMediaId: first.mediaId,
      registeredBy: target.by,
      now: this.now(),
    });
    if (!created) throw new AppError('MEDIA_CONFLICT', 'This speaker has one');
    return this.viewOf(profileId);
  }

  /**
   * The list first, then the print: a crash after either leaves a revocation the next start
   * finishes, never a print or a profile of someone who revoked.
   */
  async revoke(actor: VoiceProfileActor, profileId: string): Promise<void> {
    this.visible(actor, profileId);
    await this.deps.revocations.add(profileId);
    await this.deps.prints.remove(profileId);
    const revoked = this.deps.profiles.revoke({
      profileId,
      by: actor.email,
      now: this.now(),
    });
    if (!revoked) throw notFound();
  }

  /**
   * "Calcular de novo", for a job given up or a print lost with a disk. The store decides
   * first, in one transaction: a refusal must not cost a valid print.
   */
  async recalculate(
    actor: VoiceProfileActor,
    profileId: string,
  ): Promise<VoiceProfile> {
    this.visible(actor, profileId);
    await this.assertMayPrint(profileId);
    const queued = this.deps.profiles.recalculate({
      profileId,
      jobId: randomUUID(),
      now: this.now(),
    });
    if (!queued)
      throw new AppError('MEDIA_CONFLICT', 'This profile cannot be queued');
    await this.deps.prints.remove(profileId);
    return this.viewOf(profileId);
  }

  report(): VoiceConsentEntry[] {
    return this.deps.profiles.report();
  }

  evidence(consentId: string): ConsentDocument {
    const stored = this.deps.profiles.evidence(consentId);
    if (!stored) throw notFound();
    const plain = this.deps.sealer.open(stored.sealed, contextOf(consentId));
    if (stored.kind === 'text')
      return {
        mime: TEXT_MIME,
        data: Buffer.from(plain, 'utf8'),
        extension: 'txt',
      };
    const mime = stored.mime ?? 'application/octet-stream';
    return {
      mime,
      data: Buffer.from(plain, 'base64'),
      extension: EXTENSIONS[mime] ?? 'bin',
    };
  }

  /** No print for someone who revoked, nor any at all while the list is lost (ADR 0032). */
  private async assertMayPrint(profileId?: string): Promise<void> {
    const { ids, complete } = await this.deps.revocations.read();
    if (!complete || (profileId !== undefined && ids.includes(profileId)))
      throw new AppError('MEDIA_CONFLICT', 'This consent was revoked');
  }

  private consentOf(sent: unknown): VoiceConsent {
    const consent = voiceConsentSchema.safeParse(sent);
    if (!consent.success)
      throw new AppError('CONSENT_REQUIRED', 'A consent must come first', {
        details: { field: 'consent' },
      });
    if (consent.data.grantedOn > dayOf(this.now()))
      throw new AppError('CONSENT_REQUIRED', 'The date is in the future', {
        details: { field: 'grantedOn' },
      });
    return consent.data;
  }

  private sealEvidence(
    consentId: string,
    evidence: VoiceConsentEvidence,
  ): SealedEvidence {
    const { sealer } = this.deps;
    if (evidence.kind === 'text')
      return {
        kind: 'text',
        fileName: null,
        mime: null,
        sealed: sealer.seal(evidence.text, contextOf(consentId)),
      };
    if (
      Buffer.byteLength(evidence.data, 'base64') > MAX_CONSENT_ATTACHMENT_BYTES
    )
      throw new AppError('PAYLOAD_TOO_LARGE', 'The document is too large');
    return {
      kind: 'attachment',
      fileName: evidence.fileName,
      mime: evidence.mime,
      sealed: sealer.seal(evidence.data, contextOf(consentId)),
    };
  }

  private speakerOf(collection: string, speakerId: string): StoredSpeaker {
    const speaker = this.deps.speakers.get(speakerId);
    if (speaker?.collection !== collection)
      throw new AppError('VALIDATION_FAILED', 'Unknown speaker', {
        details: { field: 'speakerId' },
      });
    return speaker;
  }

  /** Each source must be a voice a person named as this speaker (BR-1), enough of them. */
  private resolveSources(
    topic: string,
    request: CreateVoiceProfileRequest,
  ): StoredNamedVoice[] {
    const named = this.voicesOf(topic, request.speakerId);
    const sameVoice = (sent: VoiceSource) => (one: StoredNamedVoice) =>
      one.mediaId === sent.mediaId && one.voice === sent.voice;
    const sources = request.sources.map((sent) => {
      const found = named.find(sameVoice(sent));
      if (!found) throw invalidSources();
      return found;
    });
    const speech = sources.reduce((sum, one) => sum + one.speakingMs, 0);
    if (speech < MIN_PROFILE_SPEECH_MS) throw invalidSources();
    return sources;
  }

  /** On the collection and its sub-collections only (BR-4). */
  private voicesOf(topic: string, speakerId: string): StoredNamedVoice[] {
    const root = this.deps.rootOf(topic);
    return this.deps.profiles
      .namedVoices(speakerId)
      .filter((voice) => this.deps.rootOf(voice.topic) === root);
  }

  private visible(
    actor: VoiceProfileActor,
    profileId: string,
  ): StoredVoiceProfile {
    const profile = this.deps.profiles.get(profileId);
    if (!profile || !actor.canSee(profile.collection)) throw notFound();
    return profile;
  }

  private async viewOf(profileId: string): Promise<VoiceProfile> {
    const profile = this.deps.profiles.get(profileId);
    if (!profile) throw notFound();
    return this.toView(profile);
  }

  private async toView(profile: StoredVoiceProfile): Promise<VoiceProfile> {
    const { id, speakerId, speakerName, sourceCount } = profile;
    return {
      id,
      speakerId,
      speakerName: this.nameOf(speakerId) ?? speakerName,
      status: await this.statusOf(profile),
      sourceCount,
      grantedBy: profile.grantedBy,
      grantedOn: profile.grantedOn,
      createdAt: profile.createdAt,
    };
  }

  private nameOf(speakerId: string): string | null {
    const speaker = this.deps.speakers.get(speakerId);
    return speaker && toCollectionSpeaker(speaker, this.deps.authorOf).name;
  }

  /** A job at work says so; else a print that opens is ready, and no such print asks to redo it. */
  private async statusOf(
    profile: StoredVoiceProfile,
  ): Promise<VoiceProfileStatus> {
    if (JOB_RUNNING.includes(profile.jobStatus)) return 'calculating';
    const opens =
      profile.model !== null && (await this.deps.prints.opens(profile.id));
    return opens ? 'ready' : 'failed';
  }
}
