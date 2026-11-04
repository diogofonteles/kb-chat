import type { FastifyBaseLogger } from 'fastify';
import type { HouseAi } from './house-ai-factory.js';
import type { MediaDeps } from './media-factory.js';
import type { AuthorsService } from './modules/authors/index.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import type { MediaService } from './modules/media/index.js';
import {
  SubjectDirectory,
  SubjectProposalService,
  TrackSubjectService,
  TrackSuggestionService,
} from './modules/track-subjects/index.js';
import { mediaLlm } from './track-proposals-factory.js';

export interface TrackSubjectWiring {
  readonly media: MediaDeps;
  readonly house: HouseAi;
  readonly catalog: CatalogRegistry;
  readonly authors: AuthorsService;
  readonly service: MediaService;
  readonly log: FastifyBaseLogger;
}

const capsOf = ({ ai }: MediaDeps) => ({
  runUsd: ai.runCapUsd,
  monthlyUsd: ai.monthlyCapUsd,
});

/** Subjects as the search and the library read them (KBC-070). */
export function createSubjectDirectory(
  wiring: Pick<TrackSubjectWiring, 'media' | 'catalog' | 'authors'>,
): SubjectDirectory {
  const { media, catalog, authors } = wiring;
  return new SubjectDirectory({
    store: media.trackSubjects,
    rootOf: (topic) => authors.rootOf(topic),
    conceptsOf: (root) => catalog.get(root)?.relations.conceptNames() ?? [],
  });
}

/** Subjects of a track over the media database, the catalog read-only (KBC-069). */
export function createTrackSubjects(wiring: TrackSubjectWiring) {
  const { media, catalog, authors, service } = wiring;
  const subjects = new TrackSubjectService({
    store: media.trackSubjects,
    media: media.store,
    items: media.trackItems,
    findMedia: (actor, mediaId) => service.getRecording(actor, mediaId),
    rootOf: (topic) => authors.rootOf(topic),
    conceptsOf: (root) => catalog.get(root)?.relations.conceptNames() ?? [],
    directory: createSubjectDirectory(wiring),
    history: media.trackRevisions,
  });
  const proposals = new SubjectProposalService({
    store: media.trackSubjects,
    ledger: media.spend,
    subjects,
    items: media.trackItems,
    edits: media.edits,
    transcripts: media.transcripts,
    findMedia: (actor, mediaId) => service.getRecording(actor, mediaId),
    titleOf: (topic) => catalog.get(topic)?.topic.title ?? topic,
    llm: mediaLlm(wiring),
    caps: capsOf(media),
    onRunError: (err, runId) =>
      wiring.log.warn({ err, runId }, 'subject run failed'),
  });
  return {
    subjects,
    proposals,
    suggestions: suggestionService(wiring, subjects),
  };
}

/** "Sugerir de novo com IA" for one track (KBC-073 FR-7). */
function suggestionService(
  wiring: TrackSubjectWiring,
  subjects: TrackSubjectService,
): TrackSuggestionService {
  const { media, authors, service } = wiring;
  return new TrackSuggestionService({
    ledger: media.spend,
    subjects,
    store: media.store,
    speakers: media.speakers,
    transcripts: media.transcripts,
    findMedia: (actor, mediaId) => service.get(actor, mediaId),
    rootOf: (topic) => authors.rootOf(topic),
    llm: mediaLlm(wiring),
    caps: capsOf(media),
    onError: (err, mediaId) =>
      wiring.log.warn({ err, mediaId }, 'track suggestion failed'),
  });
}
