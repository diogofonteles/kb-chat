import type { MediaItem } from '@kb-chat/contracts';
import type { FastifyBaseLogger } from 'fastify';
import { OpenRouterAdapter } from './adapters/openrouter-adapter.js';
import type { HouseAi } from './house-ai-factory.js';
import type { MediaDeps } from './media-factory.js';
import type { AuthorsService } from './modules/authors/index.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import type { DiarizationService, MediaActor } from './modules/media/index.js';
import { VoiceNameFixer } from './modules/media-edit/index.js';
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
export function mediaLlm(
  wiring: Pick<TrackProposalWiring, 'media' | 'house'>,
): () => LlmPort | null {
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

/** The voice of each segment a run reads, once voices are separated (KBC-064). */
function segmentVoicesOf(wiring: TrackProposalWiring) {
  return (mediaId: string, transcriptId: string) => {
    const transcript = wiring.media.transcripts
      .transcripts(mediaId)
      .find((one) => one.id === transcriptId);
    if (!transcript) return null;
    const voices = wiring.diarization.voicesOn(mediaId, transcript);
    return voices?.segmentVoices ?? null;
  };
}

/** The AI's track proposals over the media database (KBC-067). */
/** Who keeps the AI's words in line with the names people give (KBC-090). */
export function voiceNameFixerOf(media: MediaDeps): VoiceNameFixer {
  const latest = (mediaId: string) => media.diarizations.latest(mediaId);
  return new VoiceNameFixer({
    proposals: media.trackProposals,
    labels: (mediaId) => {
      const separation = latest(mediaId);
      return separation ? media.voiceLabels.labels(separation.id) : [];
    },
    refused: (mediaId) => {
      const separation = latest(mediaId);
      return separation ? media.voiceLabels.refusedNames(separation.id) : [];
    },
    edits: media.edits,
    revisions: media.trackRevisions,
  });
}

/** A slip here must not fail a paid run: the words wait for the next window or name. */
function fixWindow({ media, log }: TrackProposalWiring, mediaId: string): void {
  try {
    voiceNameFixerOf(media).fix(mediaId, null);
  } catch (err) {
    log.warn({ err, mediaId }, 'could not fix a name in a proposal');
  }
}

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
    segmentVoices: segmentVoicesOf(wiring),
    llm: mediaLlm(wiring),
    caps: {
      runUsd: media.ai.runCapUsd,
      // The owner may change the media cap at any time (KBC-037 BR-2): read it live.
      get monthlyUsd() {
        return media.ai.monthlyCapUsd;
      },
    },
    onRunError: (err, runId) =>
      wiring.log.warn({ err, runId }, 'track proposal run failed'),
    onWindowSaved: (mediaId) => fixWindow(wiring, mediaId),
  });
}
