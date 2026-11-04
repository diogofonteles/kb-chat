import type { MediaItem } from '@kb-chat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { OpenRouterAdapter } from './adapters/openrouter-adapter.js';
import type { HouseAi } from './house-ai-factory.js';
import type { MediaDeps } from './media-factory.js';
import type { AuthorsService } from './modules/authors/index.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import type { DiarizationService, MediaActor } from './modules/media/index.js';
import { ProposalService } from './modules/track-proposals/index.js';
import type { LlmPort } from './ports/llm.js';

/** Low temperature, as measured in KBC-063 (propose_tracks.py). */
const PROPOSAL_TEMPERATURE = 0.2;

export interface TrackProposalWiring {
  readonly media: MediaDeps;
  readonly house: HouseAi;
  readonly catalog: CatalogRegistry;
  readonly authors: AuthorsService;
  readonly findMedia: (actor: MediaActor, mediaId: string) => MediaItem;
  readonly diarization: Pick<DiarizationService, 'voicesOn'>;
  readonly log: FastifyBaseLogger;
}

/**
 * The media AI (KBC-067 BR-7, ADR 0029 §7): the house OpenRouter account a master connected
 * (ADR 0016), on the model of MEDIA_AI_MODEL, JSON out, only providers that neither train on
 * nor keep the text (`data_collection: deny`, `zdr`: DeepSeek V4 Flash has ZDR endpoints).
 * One adapter per key, so the model's price is fetched once.
 */
function mediaLlm(wiring: TrackProposalWiring): () => LlmPort | null {
  let cached: { key: string; llm: LlmPort } | null = null;
  return () => {
    const key = wiring.house.service.houseKey();
    if (!key) return null;
    if (cached?.key !== key)
      cached = {
        key,
        llm: new OpenRouterAdapter({
          apiKey: key,
          model: wiring.media.ai.model,
          fetch: wiring.house.fetch,
          request: {
            jsonOutput: true,
            denyDataCollection: true,
            zeroRetention: true,
            temperature: PROPOSAL_TEMPERATURE,
          },
        }),
      };
    return cached.llm;
  };
}

/** The AI's track proposals over the media database (KBC-067). */
export function createTrackProposals(
  wiring: TrackProposalWiring,
): ProposalService {
  const { media, catalog, authors } = wiring;
  return new ProposalService({
    store: media.trackProposals,
    ledger: media.spend,
    transcripts: media.transcripts,
    findMedia: wiring.findMedia,
    contextOf: (topic) => ({
      collection: catalog.get(topic)?.topic.title ?? topic,
      knownNames: authors.list(topic).map((author) => author.name),
    }),
    segmentVoices: (mediaId, transcriptId) => {
      const transcript = media.transcripts
        .transcripts(mediaId)
        .find((one) => one.id === transcriptId);
      if (!transcript) return null;
      return (
        wiring.diarization.voicesOn(mediaId, transcript)?.segmentVoices ?? null
      );
    },
    llm: mediaLlm(wiring),
    caps: {
      runUsd: media.ai.runCapUsd,
      monthlyUsd: media.ai.monthlyCapUsd,
    },
    onRunError: (err, runId) =>
      wiring.log.warn({ err, runId }, 'track proposal run failed'),
  });
}
