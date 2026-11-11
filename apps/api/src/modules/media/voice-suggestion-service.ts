import type {
  DecideVoiceSuggestionRequest,
  MediaSpeakers,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { VoiceProfileStorePort } from '../../ports/voice-profile-store.js';
import type { MediaActor } from './media-service.js';
import type { VoiceNamesService } from './voice-names-service.js';

export interface VoiceSuggestionServiceDeps {
  readonly profiles: VoiceProfileStorePort;
  readonly names: VoiceNamesService;
  readonly speakersOf: (actor: MediaActor, mediaId: string) => MediaSpeakers;
  readonly now?: () => Date;
}

/**
 * A person's answer to "parece ser" (KBC-071 AC-2): accepting names the voice as any other
 * name is given, refusing keeps it unnamed. Nothing else turns a suggestion into a name.
 */
export class VoiceSuggestionService {
  private readonly now: () => Date;

  constructor(private readonly deps: VoiceSuggestionServiceDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  decide(
    actor: MediaActor,
    target: { readonly mediaId: string; readonly voice: number },
    request: DecideVoiceSuggestionRequest,
  ): MediaSpeakers {
    const { mediaId, voice } = target;
    const { version, decision } = request;
    const { current } = this.deps.names.editable(actor, mediaId, version);
    const suggestion = this.deps.speakersOf(actor, mediaId).voiceSuggestions;
    const speakerId = suggestion.find((one) => one.voice === voice)?.speakerId;
    if (!speakerId)
      throw new AppError('NOT_FOUND', 'No suggestion for this voice');
    if (decision === 'accept')
      this.deps.names.name(actor, target, {
        version,
        speakerId,
        audience: false,
      });
    this.deps.profiles.decide({
      diarizationId: current.id,
      voice,
      status: decision === 'accept' ? 'accepted' : 'refused',
      by: actor.principal,
      now: this.now(),
    });
    return this.deps.speakersOf(actor, mediaId);
  }
}
