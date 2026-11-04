import type { Author } from '@kb-chat/contracts';
import type { MediaDeps } from './media-factory.js';
import {
  TrackRevisionService,
  type TrackPublisher,
} from './modules/media-edit/index.js';
import {
  VoiceNamesService,
  type DiarizationService,
  type MediaActor,
  type MediaService,
} from './modules/media/index.js';

export interface TrackRevisionWiring {
  readonly media: MediaDeps;
  readonly service: MediaService;
  readonly publisher: TrackPublisher;
  readonly diarization: DiarizationService;
  readonly authors: {
    rootOf(topic: string): string;
    authorOf(topic: string, slug: string): Author | null;
  };
}

/** What changes a track after its approval (KBC-073), over the stores of the media database. */
export function createTrackRevisions(
  wiring: TrackRevisionWiring,
): TrackRevisionService {
  const { media, service, publisher, diarization, authors } = wiring;
  const rootOf = (topic: string) => authors.rootOf(topic);
  const speakersOf = (actor: MediaActor, mediaId: string) =>
    diarization.speakers(actor, mediaId);
  return new TrackRevisionService({
    revisions: media.trackRevisions,
    publisher,
    edits: media.edits,
    store: media.store,
    files: media.files,
    summaries: media.trackSubjects,
    speakers: media.speakers,
    diarizations: media.diarizations,
    voiceLabels: media.voiceLabels,
    names: new VoiceNamesService({ ...media, rootOf, speakersOf }),
    findMedia: (actor, mediaId) => service.get(actor, mediaId),
    rootOf,
    authorOf: (topic, slug) => authors.authorOf(topic, slug),
  });
}

/** Who a track says speaks in its voices, whatever the recording's names (KBC-073 FR-1). */
export function trackVoiceNames(
  { trackRevisions, speakers }: Pick<MediaDeps, 'trackRevisions' | 'speakers'>,
  authorOf: (topic: string, slug: string) => Author | null,
) {
  return (mediaId: string, topic: string) => {
    const track = trackRevisions.track(mediaId);
    if (!track) return [];
    const own = [
      { voice: track.askerVoice, speakerId: track.askerSpeakerId },
      { voice: track.answererVoice, speakerId: track.answererSpeakerId },
    ];
    return own.flatMap(({ voice, speakerId }) => {
      const speaker = speakerId ? speakers.get(speakerId) : null;
      if (voice === null || !speaker) return [];
      const { authorSlug } = speaker;
      const author = authorSlug ? authorOf(topic, authorSlug) : null;
      return [
        { voice, speakerId: speaker.id, name: author?.name ?? speaker.name },
      ];
    });
  };
}
