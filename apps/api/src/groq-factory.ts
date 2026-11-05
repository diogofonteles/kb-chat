import type { FastifyBaseLogger } from 'fastify';
import type { MediaDeps } from './media-factory.js';
import {
  GroqPacer,
  GroqService,
  type TranscriberService,
} from './modules/media/index.js';

/** The Groq fallback over the media library's stores (KBC-037, ADR 0023 §7). */
export function createGroq(input: {
  readonly media: MediaDeps;
  readonly transcribers: TranscriberService;
  readonly log: FastifyBaseLogger;
}): GroqService {
  const { media, transcribers, log } = input;
  return new GroqService({
    settings: media.settings,
    sealer: media.groq.sealer,
    groq: media.groq.api,
    ledger: media.spend,
    queue: media.groq.queue,
    transcripts: media.transcripts,
    presence: () => transcribers.presence('transcribe'),
    pacer: new GroqPacer(),
    defaultCapUsd: media.groq.defaultCapUsd,
    log,
  });
}
