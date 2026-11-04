import type { FastifyBaseLogger } from 'fastify';
import type { HouseAi } from './house-ai-factory.js';
import type { MediaDeps } from './media-factory.js';
import type { AuthorsService } from './modules/authors/index.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import type { MediaService } from './modules/media/index.js';
import {
  SubjectProposalService,
  TrackSubjectService,
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
    caps: { runUsd: media.ai.runCapUsd, monthlyUsd: media.ai.monthlyCapUsd },
    onRunError: (err, runId) =>
      wiring.log.warn({ err, runId }, 'subject run failed'),
  });
  return { subjects, proposals };
}
