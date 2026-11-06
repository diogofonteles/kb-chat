import type {
  ConfirmVoicesRequest,
  MediaSpeakers,
  MergeVoicesRequest,
  NameVoiceRequest,
  RefuseVoiceNameRequest,
  SplitVoiceRequest,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type {
  DiarizationStorePort,
  DiarizationSummary,
} from '../../ports/diarization-store.js';
import type { MediaRecord, MediaStorePort } from '../../ports/media-store.js';
import type {
  SpeakerStorePort,
  VoiceLabelStorePort,
} from '../../ports/speaker-store.js';
import type { MediaActor } from './media-service.js';
import { aliasOf } from './voice-labels.js';

export interface VoiceNamesServiceDeps {
  readonly store: Pick<MediaStorePort, 'getMedia'>;
  readonly diarizations: Pick<DiarizationStorePort, 'latest' | 'turns'>;
  readonly voiceLabels: VoiceLabelStorePort;
  readonly speakers: Pick<SpeakerStorePort, 'get'>;
  readonly rootOf: (topic: string) => string;
  /** The voices as they read after a change. */
  readonly speakersOf: (actor: MediaActor, mediaId: string) => MediaSpeakers;
  /** Writes a new name and, with it, what follows from it (KBC-090); default: only the name. */
  readonly relabel?: (
    actor: MediaActor,
    target: { readonly mediaId: string; readonly voice: number },
    apply: () => void,
  ) => void;
  readonly now?: () => Date;
}

const conflict = (message: string) => new AppError('MEDIA_CONFLICT', message);

/**
 * Who the voices of a recording are (KBC-065 FR-2, FR-5, ADR 0029 §2). Every change names the
 * separation it was made on: voice numbers mean nothing in another version, so a change made
 * on an older screen is refused instead of landing on the wrong voice.
 */
export class VoiceNamesService {
  constructor(private readonly deps: VoiceNamesServiceDeps) {}

  name(
    actor: MediaActor,
    target: { readonly mediaId: string; readonly voice: number },
    request: NameVoiceRequest,
  ): MediaSpeakers {
    const { mediaId, voice } = target;
    const { media, current } = this.editable(actor, mediaId, request.version);
    this.assertStandingVoice(current.id, voice);
    this.assertSpeakerOf(media, request.speakerId);
    this.relabel(actor, target, () =>
      this.deps.voiceLabels.setLabel({
        diarizationId: current.id,
        voice,
        speakerId: request.speakerId,
        audience: request.audience,
      }),
    );
    return this.deps.speakersOf(actor, mediaId);
  }

  private relabel(
    actor: MediaActor,
    target: { readonly mediaId: string; readonly voice: number },
    apply: () => void,
  ): void {
    if (this.deps.relabel) this.deps.relabel(actor, target, apply);
    else apply();
  }

  /**
   * The name suggested or accepted is not this voice's (KBC-090): the voice is left with no
   * name, and nobody is offered that one again.
   */
  refuseName(
    actor: MediaActor,
    target: { readonly mediaId: string; readonly voice: number },
    request: RefuseVoiceNameRequest,
  ): MediaSpeakers {
    const { mediaId, voice } = target;
    const { current } = this.editable(actor, mediaId, request.version);
    this.assertStandingVoice(current.id, voice);
    const { voiceLabels } = this.deps;
    this.relabel(actor, target, () => {
      voiceLabels.setLabel({
        diarizationId: current.id,
        voice,
        speakerId: null,
        audience: false,
      });
      voiceLabels.refuseName({
        diarizationId: current.id,
        voice,
        by: actor.principal,
        now: this.deps.now?.() ?? new Date(),
      });
    });
    return this.deps.speakersOf(actor, mediaId);
  }

  merge(
    actor: MediaActor,
    mediaId: string,
    request: MergeVoicesRequest,
  ): MediaSpeakers {
    const { voice, into, version } = request;
    const { current } = this.editable(actor, mediaId, version);
    this.assertStandingVoice(current.id, voice);
    this.assertStandingVoice(current.id, into);
    this.deps.voiceLabels.merge({ diarizationId: current.id, voice, into });
    return this.deps.speakersOf(actor, mediaId);
  }

  split(
    actor: MediaActor,
    mediaId: string,
    request: SplitVoiceRequest,
  ): MediaSpeakers {
    const { voice, version } = request;
    const { current } = this.editable(actor, mediaId, version);
    this.deps.voiceLabels.split({ diarizationId: current.id, voice });
    return this.deps.speakersOf(actor, mediaId);
  }

  /** "Confirmar nomes" (FR-5): from now on listeners read them. */
  confirm(
    actor: MediaActor,
    mediaId: string,
    request: ConfirmVoicesRequest,
  ): MediaSpeakers {
    const { current } = this.editable(actor, mediaId, request.version);
    this.deps.voiceLabels.confirmNames(current.id);
    return this.deps.speakersOf(actor, mediaId);
  }

  /** The item and its newest separation, which must be the one the change was made on. */
  editable(
    actor: MediaActor,
    mediaId: string,
    version: number,
  ): { media: MediaRecord; current: DiarizationSummary } {
    const media = this.deps.store.getMedia(mediaId);
    if (!media || !actor.canSee(media.topic))
      throw new AppError('MEDIA_NOT_FOUND', 'Unknown media');
    const current = this.deps.diarizations.latest(mediaId);
    if (!current)
      throw new AppError('MEDIA_NOT_READY', 'This media has no voices yet');
    if (current.version !== version)
      throw conflict('The voices were separated again');
    return { media, current };
  }

  /** A voice of this separation that was not joined to another. */
  private assertStandingVoice(diarizationId: string, voice: number): void {
    const { diarizations, voiceLabels } = this.deps;
    if (!diarizations.turns(diarizationId).some((one) => one.voice === voice))
      throw new AppError('NOT_FOUND', 'Unknown voice');
    if (aliasOf(voiceLabels.labels(diarizationId)).has(voice))
      throw conflict('This voice was joined to another');
  }

  private assertSpeakerOf(media: MediaRecord, speakerId: string | null): void {
    if (speakerId === null) return;
    const speaker = this.deps.speakers.get(speakerId);
    if (speaker?.collection !== this.deps.rootOf(media.topic))
      throw new AppError('VALIDATION_FAILED', 'Unknown speaker', {
        details: { field: 'speakerId' },
      });
  }
}
