import type { Author } from '@kb-chat/contracts';
import type { MediaDeps } from './media-factory.js';
import { voiceNameFixerOf } from './track-proposals-factory.js';
import {
  TrackRevisionService,
  type TrackPublisher,
} from './modules/media-edit/index.js';
import {
  VoiceNamesService,
  type DiarizationService,
  type MediaActor,
  type MediaLevels,
  type MediaService,
} from './modules/media/index.js';
import type { LevelAuditPort } from './ports/level-audit.js';

export interface TrackRevisionWiring {
  readonly media: MediaDeps;
  readonly service: MediaService;
  readonly publisher: TrackPublisher;
  readonly diarization: DiarizationService;
  readonly authors: {
    rootOf(topic: string): string;
    authorOf(topic: string, slug: string): Author | null;
  };
  /** The scales, the levels audit and the log of a track's level change (KBC-106). */
  readonly trackLevels?: MediaLevels;
  readonly levelAudit?: LevelAuditPort;
  readonly log?: { error(fields: object, message: string): void };
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
    fixer: voiceNameFixerOf(media),
    // Every route of a track's edit: refused below a track of the recording (KBC-106).
    findMedia: (actor, mediaId) => service.editable(actor, mediaId),
    ...(wiring.trackLevels && { levels: wiring.trackLevels }),
    ...(wiring.levelAudit && { audit: wiring.levelAudit }),
    ...(wiring.log && { log: wiring.log }),
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
