import { AppError } from './app-error.js';
import { basename, join } from 'node:path';
import { JsonDocumentStore } from './adapters/json-document-store.js';
import {
  InviteProfilesService,
  inviteProfilesRoutes,
} from './modules/invite-profiles/index.js';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';
import type { MediaSpeakers, ResearchProfile } from '@kb-chat/contracts';
import type { AppConfig } from './config.js';
import { registerErrorHandler } from './error-handler.js';
import { MemorySpendLedger } from './adapters/memory-spend-ledger.js';
import {
  AuthorDirectory,
  AuthorsService,
  authorRoutes,
  seedLegacyAuthors,
  LEGACY_MAIN_AUTHOR,
} from './modules/authors/index.js';
import { CatalogRegistry } from './modules/catalog/index.js';
import { DocumentsService, documentRoutes } from './modules/documents/index.js';
import {
  LiveTurns,
  TURN_CEILING_MS,
  researchRoutes,
  type ResearchRouteOptions,
} from './modules/research/index.js';
import { SpendService, spendRoutes } from './modules/spend/index.js';
import { healthRoutes } from './modules/health/index.js';
import {
  SearchWithMedia,
  SubjectSearch,
  searchRoutes,
} from './modules/search/index.js';
import {
  CollectionRegistry,
  CollectionsVault,
  TopicsService,
  topicRoutes,
} from './modules/topics/index.js';
import authGuard from './plugins/auth-guard.js';
import csrfGuard from './plugins/csrf-guard.js';
import hostGuard from './plugins/host-guard.js';
import routeAccess from './plugins/route-access.js';
import {
  Invitations,
  Notifier,
  OWNER_PRINCIPAL,
  OneTimeCodes,
  PeopleService,
  RequestTickets,
  SendLimits,
  SessionService,
  ActAsService,
  actAsRoutes,
  authRoutes,
  codeRoutes,
  NO_PARENT,
  canSeeTopic,
  hasFeature,
  invitationRoutes,
  isMaster,
  peopleRoutes,
  type StoredPerson,
} from './modules/auth/index.js';
import {
  AccessRequestService,
  SignUpFlow,
  accessRequestRoutes,
} from './modules/access-requests/index.js';
import { MemoryDocumentStore } from './adapters/memory-document-store.js';
import { MemoryOutbox } from './adapters/memory-outbox.js';
import type { Delivery } from './delivery-factory.js';
import type { DocumentStorePort } from './ports/document-store.js';
import { MemoryPeopleStore } from './adapters/memory-people-store.js';
import { MemorySessionStore } from './adapters/memory-session-store.js';
import { MemoryActAsAudit } from './adapters/memory-act-as-audit.js';
import { MemoryLevelAudit } from './adapters/memory-level-audit.js';
import type { LevelAuditPort } from './ports/level-audit.js';
import {
  AccessLevelsService,
  ContentGate,
  LevelDirectory,
  DocumentLevelsService,
  LevelWriteQueue,
  accessLevelRoutes,
} from './modules/access-levels/index.js';
import { createGoogleVerifier } from './adapters/google-id-token-verifier.js';
import type { IdentityVerifierPort } from './ports/identity-verifier.js';
import type { AgentLlmPort } from './ports/llm.js';
import type { ResearchRunnerPort } from './ports/research-runner.js';
import type { SearchIndexPort } from './ports/search-index.js';
import type { SpendLedgerPort } from './ports/spend-ledger.js';
import type { UsageLogPort } from './ports/usage-log.js';
import type { VaultReaderPort } from './ports/vault-reader.js';
import { MemoryUsageLog } from './adapters/memory-usage-log.js';
import { MemoryConversationStore } from './adapters/memory-conversation-store.js';
import type { ConversationStorePort } from './ports/conversation-store.js';
import {
  ConversationsService,
  conversationRoutes,
} from './modules/conversations/index.js';
import { usageRoutes } from './modules/usage/index.js';
import {
  JANITOR_INTERVAL_MS,
  MediaJanitor,
  MediaService,
  SilenceService,
  WaveformService,
  WorkerService,
  listeningRoutes,
  libraryRoutes,
  LibraryService,
  bookmarkRoutes,
  BookmarkService,
  ListeningService,
  mediaRoutes,
  type PlanActor,
  MediaEditService,
  silenceRoutes,
  waveformRoutes,
  DiarizationService,
  SpeakersService,
  VoiceNamesService,
  collectionSpeakerRoutes,
  speakerRoutes,
  countPromptTokens,
  termRoutes,
  TermListService,
  transcriberRoutes,
  TranscriberStatusBoard,
  transcriberStatusRoutes,
  STARTING_GRACE_MS,
  TranscriberWaker,
  watchForTranscriberWork,
  TranscriberService,
  TranscriptionService,
  TranscriptService,
  transcriptRoutes,
  workerRoutes,
  groqRoutes,
  type GroqService,
  VoicePrintReconciler,
  VoicePrintService,
  VoiceProfileService,
  VoiceSuggestionService,
  voiceProfileRoutes,
  type MediaActor,
  type MediaLevels,
} from './modules/media/index.js';
import type { MediaStorePort } from './ports/media-store.js';
import type { MediaDeps } from './media-factory.js';
import { createGroq } from './groq-factory.js';
import type { TranscriptSummary } from './ports/transcript-store.js';
import { createLogger } from './logger.js';
import { MemorySettingsStore } from './adapters/memory-settings-store.js';
import { mcpRoutes, peerOnlyMcp } from './mcp/mcp-routes.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { SecretBox } from './adapters/secret-box.js';
import { createHouseAi, type HouseAi } from './house-ai-factory.js';
import {
  PreparationService,
  preparationRoutes,
} from './modules/preparation/index.js';
import { createTrackProposals } from './track-proposals-factory.js';
import {
  createSubjectDirectory,
  createTrackSubjects,
} from './track-subjects-factory.js';
import {
  createTrackRevisions,
  trackVoiceNames,
} from './track-revisions-factory.js';
import {
  type ProposalService,
  trackProposalRoutes,
} from './modules/track-proposals/index.js';
import {
  trackSubjectRoutes,
  type SubjectProposalService,
} from './modules/track-subjects/index.js';
import {
  TrackEditService,
  TrackPublisher,
  mediaEditRoutes,
  trackRevisionRoutes,
  type TrackRevisionService,
} from './modules/media-edit/index.js';
import {
  LearningService,
  TranscriptCorrectionService,
  correctionRoutes,
  learningRoutes,
} from './modules/media-corrections/index.js';
import { houseAiRoutes } from './modules/house-ai/index.js';
import { settingsRoutes } from './modules/settings/index.js';
import {
  MediaTrackShelf,
  existingTracksRoutes,
  publicationRoutes,
} from './modules/media-documents/index.js';
import {
  createMediaDocuments,
  seenIn,
  startDocumentBackstop,
  type MediaDocuments,
} from './media-documents-factory.js';
import {
  createAiProviders,
  type AiProviders,
} from './providers/create-ai-providers.js';
import {
  budgetsFromConfig,
  createResearchAgent,
  type ResearchAgent,
} from './research-agent-factory.js';

/** On shutdown, how long the running research turns get to record how they ended. */
const TURN_SAVE_GRACE_MS = 5_000;

/** The owner's principal: the alias of the data written before logins (ADR 0008). */
export const OWNER = OWNER_PRINCIPAL;

/** Where one-time codes and access requests are kept and how messages go (ADR 0011). */
export interface AccessDeps {
  readonly codes: DocumentStorePort;
  readonly requests: DocumentStorePort;
  readonly delivery: Delivery;
}

/** Who may sign in and how (ADR 0008); in memory, verifying with Google, when not given. */
export interface AuthDeps {
  readonly people: PeopleService;
  readonly sessions: SessionService;
  readonly verifier: IdentityVerifierPort;
  /** Masters acting as a person (KBC-060); its audit in memory when not given. */
  readonly actAs?: ActAsService;
}

export interface AppDeps {
  readonly config: AppConfig;
  readonly vault: VaultReaderPort;
  readonly index: SearchIndexPort;
  /**
   * A fixed model for every research turn (tests with a scripted stub). Without it, each
   * turn takes the runner of the provider in Settings (ai.registry, KBC-007 FR-5).
   */
  readonly llm?: AgentLlmPort;
  readonly ledger?: SpendLedgerPort;
  /** Local usage log (KBC-006); in memory when not given. */
  readonly usage?: UsageLogPort;
  /** Saved conversations (the complete history); in memory when not given. */
  readonly conversations?: ConversationStorePort;
  readonly catalog?: CatalogRegistry;
  readonly logger?: FastifyBaseLogger;
  /** Settings and AI providers (KBC-007); in memory, from the environment, when not given. */
  readonly ai?: AiProviders;
  /**
   * The research tools and loop the providers were built with (main and the E2E server);
   * built here, over `catalog`, when not given.
   */
  readonly agent?: ResearchAgent;
  readonly auth?: AuthDeps;
  /** Codes, requests and delivery (KBC-014); in memory, to an outbox, when not given. */
  readonly access?: AccessDeps;
  /**
   * The house plan (KBC-022). When not given: in memory, and OpenRouter unreachable (tests
   * never call it); `ai` must then be built with the same `house` to lend it.
   */
  readonly house?: HouseAi;
  /** The media library (ADR 0022); without it no media route exists (KB_CHAT_MEDIA=off). */
  readonly media?: MediaDeps;
  /**
   * Collections created on the screen (ADR 0028). When given, `vault` must already be its
   * CollectionsVault (main builds the catalog before the app); in memory when not given.
   */
  readonly collections?: CollectionRegistry;
  /**
   * The authors of each collection (KBC-049, ADR 0030), loaded; in memory when not given.
   * When `agent` is given it must have been built with the same directory's main authors.
   */
  readonly authorDirectory?: AuthorDirectory;
  /**
   * Access levels (KBC-103, ADR 0036): the scales and document levels and their audit; in
   * memory when not given.
   */
  readonly levels?: LevelDeps;
}

/** The levels' state and audit (main: the state folder). */
export interface LevelDeps {
  readonly directory: LevelDirectory;
  readonly audit: LevelAuditPort;
}

type FullDeps = AppDeps & {
  auth: AuthDeps & { actAs: ActAsService };
  house: HouseAi;
  access: AccessDeps;
  ai: AiProviders;
  agent: ResearchAgent;
  catalog: CatalogRegistry;
  ledger: SpendLedgerPort;
  usage: UsageLogPort;
  conversations: ConversationStorePort;
  collections: CollectionRegistry;
  authors: AuthorsService;
  levels: LevelDeps & {
    gate: ContentGate;
    service: AccessLevelsService;
    documents: DocumentLevelsService;
  };
  /** The collections the legacy seed wrote at this start (KBC-049 BR-4). */
  legacySeeded: readonly string[];
};

/** The runner of a person's turn: a fixed model in tests, else the provider in Settings. */
function researchRunnerOf(deps: FullDeps) {
  const { ai, agent, llm } = deps;
  return (
    principal: string,
    profile: ResearchProfile = 'fast',
  ): ResearchRunnerPort =>
    llm
      ? agent.perTokenRunner(llm, spendScopeOf(deps, principal))
      : ai.registry.researchRunner(principal, profile);
}

const spendScopeOf = (deps: FullDeps, principal: string) => ({
  principal,
  dailyCapUsd: () => deps.ai.registry.dailyCapUsd(principal),
});

/**
 * The research agent (ADR 0006) with the runner of the current provider, asked per turn
 * (ADR 0007), and the spend controls it shares with the side panel: per-token turns check
 * the principal's daily cap from Settings, subscription turns skip the ledger and the cap.
 */
async function registerResearch(
  app: FastifyInstance,
  deps: FullDeps,
  recording: Pick<ResearchRouteOptions, 'turns' | 'journal'>,
): Promise<void> {
  const { ai, ledger, catalog, llm } = deps;
  const runner = researchRunnerOf(deps);
  const spendFor = (principal: string) =>
    new SpendService({
      llm: llm ?? ai.registry.llm(principal),
      ledger,
      ...spendScopeOf(deps, principal),
      configured: () => runner(principal).configured(),
    });
  await app.register(
    spendRoutes({ serviceFor: spendFor, ledger, people: () => spenders(deps) }),
  );
  const hasTopic = (topic: string) => catalog.get(topic) !== undefined;
  refuseOwnAiWhileActing(app, ai);
  await app.register(
    researchRoutes({
      runner,
      hasTopic,
      ratePerMinute: deps.config.RESEARCH_RATE_LIMIT,
      ...recording,
      ...shelfOf(deps.media),
    }),
  );
}

/** The tracks of media.db one request may see as documents (ADR 0035 §5). */
const trackShelf = (media: MediaDeps) => () =>
  new MediaTrackShelf({
    store: media.store,
    transcripts: media.transcripts,
    hasTracks: (recordingId) => media.documents.hasTracks(recordingId),
    desiredOf: (mediaId) => media.documents.desiredFingerprint(mediaId),
    rowsOf: (topic) => media.documents.shelfRows(topic),
  });

/** The tracks a research turn may see (KBC-099), with the media library on. */
const shelfOf = (media: MediaDeps | undefined) =>
  media ? { shelf: trackShelf(media) } : {};

/** The research routes that run the person's AI. */
const RESEARCH_TURNS = new Set(['/api/v1/topics/:topic/research']);

/**
 * A master acting as a person may research only with the app's AI, never with the person's
 * own key or account: that spends their money (KBC-060 BR-4).
 */
function refuseOwnAiWhileActing(app: FastifyInstance, ai: AiProviders): void {
  app.addHook('preHandler', async (request) => {
    const viewer = request.viewer;
    if (!viewer?.actor || request.method !== 'POST') return;
    if (!RESEARCH_TURNS.has(request.routeOptions.url ?? '')) return;
    const status = await ai.registry.status(viewer.principal);
    if (status.source === 'own')
      throw new AppError('NOT_WHILE_ACTING', "The person's own AI is theirs");
  });
}

/** Everyone who has signed in, with the principal their spend is kept under. */
async function spenders(deps: FullDeps) {
  const { people } = deps.auth;
  return (await people.list())
    .filter((person) => person.lastLoginAt !== null)
    .map((person) => ({
      email: person.email,
      principal: people.viewerOf(person).principal,
    }));
}

/** Creating and changing collections (KBC-048), their main author included (KBC-049). */
function topicsService({ catalog, authors, auth, collections }: FullDeps) {
  return new TopicsService({
    catalog,
    registry: collections,
    grant: async (personId, slug, by) => {
      await auth.people.grantTopic(personId, slug, by);
    },
    authors: {
      mainOf: (slug) => authors.mainOf(slug),
      assertMainChoice: (slug, author) =>
        authors.assertMainChoice(slug, author),
      setMain: (slug, author) => authors.setMain(slug, author),
    },
  });
}

/** The collections (KBC-048) and their authors (KBC-049). */
async function registerCollections(
  app: FastifyInstance,
  deps: FullDeps,
): Promise<void> {
  const { config, catalog, authors } = deps;
  const service = topicsService(deps);
  await app.register(
    authorRoutes({
      service: authors,
      hasTopic: (topic) => catalog.get(topic) !== undefined,
    }),
  );
  await app.register(
    topicRoutes({
      catalog,
      service,
      mainAuthorOf: (slug) => authors.mainOf(slug),
      preferredTopic: (principal) =>
        deps.ai.settings.snapshot(principal)?.preferences.defaultTopic ??
        config.KB_TOPIC,
      ...(deps.media && { tracks: trackShelf(deps.media) }),
    }),
  );
}

/** Spoken passages beside the texts (KBC-039), tracks by subject (KBC-070). */
function combinedSearch(deps: FullDeps): SearchWithMedia {
  const { catalog, authors, media } = deps;
  const authorView = {
    mainOf: (topic: string) => authors.mainOf(topic)?.slug ?? null,
    authorOf: (topic: string, slug: string) => authors.authorOf(topic, slug),
  };
  return new SearchWithMedia({
    documents: deps.agent.search,
    scopeOf: (topic) => catalog.scope(topic).map((one) => one.topic.slug),
    media: media?.search,
    passages: media?.trackLinks,
    subjects:
      media &&
      new SubjectSearch({
        links: media.trackLinks,
        lookup: createSubjectDirectory({ ...deps, media }),
        authors: authorView,
      }),
    authors: authorView,
  });
}

/** Health, topics (with the Settings default collection) and the free search. */
async function registerSearch(
  app: FastifyInstance,
  deps: FullDeps,
): Promise<void> {
  const { config, index, catalog } = deps;
  await app.register(healthRoutes({ catalog, index }));
  await registerCollections(app, deps);
  const combined = combinedSearch(deps);
  await app.register(
    searchRoutes({
      service: deps.agent.search,
      combined,
      ratePerMinute: config.SEARCH_RATE_LIMIT,
      ...(deps.media && { tracks: trackShelf(deps.media) }),
    }),
  );
}

/** Documents with their "Veja também" and the start screen's suggestions (KBC-101 FR-6, FR-7). */
async function registerReading(
  app: FastifyInstance,
  deps: FullDeps,
): Promise<void> {
  const { config, vault, catalog, media } = deps;
  const tracks = media && { tracks: trackShelf(media) };
  const documents = new DocumentsService({
    catalog,
    vault,
    vaultName: config.OBSIDIAN_VAULT ?? basename(config.KB_VAULT),
  });
  await app.register(documentRoutes(documents, tracks ?? {}));
  await app.register(usageRoutes({ catalog, log: deps.usage, ...tracks }));
}

async function registerRoutes(
  app: FastifyInstance,
  deps: FullDeps,
): Promise<void> {
  await registerSearch(app, deps);
  await app.register(accessLevelRoutes(deps.levels));
  // Recorded research turns run apart from their request (KBC-029) and land in the history.
  const turns = new LiveTurns();
  const conversations = new ConversationsService({
    store: deps.conversations,
    scopeOf: (topic) => deps.catalog.scopeView(topic),
    isLive: (principal, turnId) => turns.isLive(principal, turnId),
    ceilingMs: TURN_CEILING_MS,
  });
  app.addHook('onClose', () => turns.close(TURN_SAVE_GRACE_MS));
  await registerResearch(app, deps, { turns, journal: conversations });
  await registerReading(app, deps);
  await app.register(conversationRoutes(conversations));
  await registerSettings(app, deps.ai, deps.config.KB_CHAT_MCP_PEERS);
  await registerAuth(app, deps);
  if (deps.media) await registerMedia(app, { ...deps, media: deps.media });
}

interface MediaWiring {
  readonly config: AppConfig;
  readonly media: MediaDeps;
  /** Who a paid stage runs for, as they stand when it starts (KBC-072 BR-4). */
  readonly auth: AuthDeps;
  readonly catalog: CatalogRegistry;
  readonly authors: AuthorsService;
  /** The app's AI a master connected: the media AI runs on it (KBC-067, ADR 0016). */
  readonly house: HouseAi;
  /** Track documents (KBC-099/100): every change reconciles them. */
  readonly documents?: MediaDocuments;
  /** The scales and their audit (KBC-105): an audio's level is one of its collection's. */
  readonly levels: FullDeps['levels'];
}

/** The collections' scales as media reads them (KBC-105, ADR 0036 §1). */
const mediaLevelsOf = ({ levels }: MediaWiring): MediaLevels => ({
  scaleOf: (topic) =>
    levels.gate.scaleOf(topic).map(({ id, code }) => ({ id, code })),
});

/** A new transcription job for an item, queued now. */
const transcriptionRequester =
  ({ transcripts }: MediaDeps) =>
  (mediaId: string) =>
    transcripts.requestTranscription({
      mediaId,
      jobId: randomUUID(),
      now: new Date(),
    });

/** A collection's media, with its sub-collections' (ADR 0028). */
function mediaService(
  wiring: MediaWiring & {
    transcribers: TranscriberService;
    groq: GroqService;
  },
): MediaService {
  const { media, catalog, authors, transcribers, groq, documents } = wiring;
  const { store, files, listening } = media;
  return new MediaService({
    levels: mediaLevelsOf(wiring),
    ...removalsOf(documents),
    store,
    files,
    listening,
    tracks: media.trackItems,
    oldCuts: media.trackRevisions,
    presence: () => transcribers.presence(),
    groqReady: () => groq.ready(),
    requestTranscription: transcriptionRequester(media),
    authorOf: (topic, slug) => authors.authorOf(topic, slug),
    hasTopic: (topic) => catalog.get(topic) !== undefined,
    scopeOf: (topic) => catalog.scope(topic).map((one) => one.topic.slug),
    rootOf: (topic) => authors.rootOf(topic),
  });
}

/** A deleted recording's documents leave the vault (KBC-100 BR-2). */
const removalsOf = (documents?: MediaDocuments) =>
  documents
    ? {
        onRemoved: (mediaId: string) =>
          documents.reconciler.reconcileRecording(mediaId),
      }
    : {};

/** Changing an item's details (KBC-050): the author and speaker lists follow a move. */
function mediaEditor(
  wiring: MediaWiring & { publisher: TrackPublisher; log: FastifyBaseLogger },
): MediaEditService {
  const { media, catalog, authors, publisher } = wiring;
  return new MediaEditService({
    levels: mediaLevelsOf(wiring),
    audit: wiring.levels.audit,
    log: wiring.log,
    store: media.store,
    speakers: media.speakers,
    hasTopic: (topic) => catalog.get(topic) !== undefined,
    rootOf: (topic) => authors.rootOf(topic),
    authorOf: (topic, slug) => authors.authorOf(topic, slug),
    onEdited: (mediaId) => publisher.afterRecordingEdit(mediaId),
  });
}

/** What approved tracks become (KBC-068, ADR 0029 §5), their documents with them (KBC-099). */
function trackPublisher(
  { media, authors }: MediaWiring,
  documents: MediaDocuments,
): TrackPublisher {
  return new TrackPublisher({
    ...media,
    items: media.trackItems,
    authorOf: (topic, slug) => authors.authorOf(topic, slug),
    onPublished: (parentId) =>
      documents.reconciler.reconcileRecording(parentId),
    onChanged: (parentId) => documents.reconciler.reconcileRecording(parentId),
    onTextChanged: (mediaIds) => documents.reconciler.reconcileTracks(mediaIds),
  });
}

/** Word corrections (KBC-093, ADR 0034): the tracks and their documents follow. */
async function registerCorrections(
  app: FastifyInstance,
  input: {
    readonly media: MediaDeps;
    readonly service: MediaService;
    readonly publisher: TrackPublisher;
  },
): Promise<TranscriptCorrectionService> {
  const { media, service, publisher } = input;
  const corrections = new TranscriptCorrectionService({
    store: media.corrections,
    media: service,
    recordOf: (mediaId) => media.store.getMedia(mediaId),
    afterChange: (recordingId, words) =>
      publisher.afterCorrection(recordingId, words),
    onCorrected: (event) => app.log.info(event, 'transcript.correction'),
  });
  await app.register(correctionRoutes(corrections));
  return corrections;
}

/** The workers' protocol: the VM's conversions and the paired transcribers' (ADR 0023). */
/** What the workers' routes are wired from. */
interface WorkerWiring {
  readonly media: MediaDeps;
  readonly transcribers: TranscriberService;
  readonly silences: SilenceService;
  readonly waveforms: WaveformService;
  readonly authors: AuthorsService;
  readonly publisher: TrackPublisher;
  readonly groq: GroqService;
  readonly documents: MediaDocuments;
  readonly corrections: TranscriptCorrectionService;
  readonly statusBoard: TranscriberStatusBoard;
  readonly learning: LearningService;
}

async function registerWorker(app: FastifyInstance, wiring: WorkerWiring) {
  const { publisher, documents, groq } = wiring;
  const voicePrints = voicePrintService(wiring);
  await app.register(
    workerRoutes({
      groq,
      service: workerService(wiring.media, {
        voicePrints,
        groq,
        documents,
        learning: wiring.learning,
      }),
      transcribers: wiring.transcribers,
      transcription: transcriptionService(wiring.media, {
        publisher,
        corrections: wiring.corrections,
        learning: wiring.learning,
      }),
      cuts: publisher,
      kbResults: documents.kb,
      vaultSyncs: documents.status,
      statusBoard: wiring.statusBoard,
      silences: wiring.silences,
      waveforms: wiring.waveforms,
      diarization: diarizationService(wiring),
      voicePrints,
    }),
  );
}

/** The queue as workers see it, with what cut and voice-profile jobs carry. */
function workerService(
  { store, files, trackItems: tracks }: MediaDeps,
  {
    voicePrints,
    groq,
    documents,
    learning,
  }: {
    voicePrints: VoicePrintService;
    groq: GroqService;
    documents: MediaDocuments;
    learning: LearningService;
  },
): WorkerService {
  return new WorkerService({
    store,
    files,
    tracks,
    // A job for Groq is prompted with the learned terms too (KBC-113 FR-4).
    termsVersion: () => learning.termsForTranscriber().version,
    voiceJobOf: (job) => voicePrints.jobOf(job),
    groqWaits: () => groq.waits(),
    kb: documents.kb,
  });
}

/** Transcripts landing, with the tracks that follow them (KBC-068 BR-4). */
function transcriptionService(
  { store, transcripts, files }: MediaDeps,
  {
    publisher,
    corrections,
    learning,
  }: {
    publisher: TrackPublisher;
    corrections: TranscriptCorrectionService;
    learning: LearningService;
  },
): TranscriptionService {
  return new TranscriptionService({
    store,
    transcripts,
    files,
    terms: () => learning.termsForTranscriber(),
    // The corrections land on the new version, then the learned rules, before its tracks are
    // cut (KBC-093 FR-8, KBC-113 FR-1).
    onTranscript: (mediaId) => {
      corrections.carry(mediaId);
      learning.apply(mediaId);
      publisher.afterTranscript(mediaId);
    },
  });
}

/** Voice prints and the transcriber (KBC-071, ADR 0032). */
function voicePrintService(wiring: {
  media: MediaDeps;
  authors: AuthorsService;
}): VoicePrintService {
  const { media, authors } = wiring;
  return new VoicePrintService({
    profiles: media.voiceProfiles,
    prints: media.voicePrintVault,
    revocations: media.voiceRevocations,
    store: media.store,
    diarizations: media.diarizations,
    voiceLabels: media.voiceLabels,
    speakers: media.speakers,
    rootOf: (topic) => authors.rootOf(topic),
    authorOf: (topic, slug) => authors.authorOf(topic, slug),
  });
}

/** What a restored backup or a crash left is put right before any route answers (ADR 0032). */
async function reconcileVoicePrints(app: FastifyInstance, media: MediaDeps) {
  const found = await new VoicePrintReconciler({
    profiles: media.voiceProfiles,
    prints: media.voicePrintVault,
    revocations: media.voiceRevocations,
  }).reconcile();
  const { listLost, listExposed, listError, ...counts } = found;
  if (Object.values(counts).some((count) => count > 0))
    app.log.warn(counts, 'voice prints reconciled');
  if (listError)
    app.log.error(
      { err: listError },
      'voice revocation list could not be written: the next start tries again',
    );
  if (listLost)
    app.log.error(
      'voice revocation list is lost: no print until it is checked',
    );
  if (listExposed)
    app.log.error(
      'voice revocation list is exposed: wrong owner or mode, nothing applied from it, no print until it is checked',
    );
}

/** "Perfis de voz" (KBC-071). */
async function registerVoiceProfiles(
  app: FastifyInstance,
  wiring: {
    media: MediaDeps;
    authors: AuthorsService;
    transcribers: TranscriberService;
  },
) {
  const { media, authors, transcribers } = wiring;
  const service = new VoiceProfileService({
    profiles: media.voiceProfiles,
    prints: media.voicePrintVault,
    revocations: media.voiceRevocations,
    speakers: media.speakers,
    store: media.store,
    sealer: media.consentSealer,
    rootOf: (topic) => authors.rootOf(topic),
    authorOf: (topic, slug) => authors.authorOf(topic, slug),
    presence: () => transcribers.presence('voice-profile'),
  });
  await reconcileVoicePrints(app, media);
  await app.register(voiceProfileRoutes(service));
}

function transcriptService(
  wiring: MediaWiring,
  services: { media: MediaService; diarization: DiarizationService },
): TranscriptService {
  const { diarization, media } = services;
  return new TranscriptService({
    transcripts: wiring.media.transcripts,
    media,
    recording: wiring.media.store,
    learnedOn: (transcriptId, segments) =>
      wiring.media.corrections.learnedOn(transcriptId, segments),
    voices: (mediaId, transcript) => diarization.voicesOn(mediaId, transcript),
    trackVoices: trackVoiceNames(wiring.media, (topic, slug) =>
      wiring.authors.authorOf(topic, slug),
    ),
  });
}

/** Each person's listening: position, bookmarks, the transcript, subtitles and voices. */
async function registerListening(
  app: FastifyInstance,
  wiring: MediaWiring,
  services: {
    media: MediaService;
    transcribers: TranscriberService;
    publisher: TrackPublisher;
  },
) {
  const { listening, bookmarks } = wiring.media;
  const { media, transcribers, publisher } = services;
  const diarization = diarizationService({ ...wiring, transcribers });
  await app.register(
    listeningRoutes(new ListeningService({ listening, media })),
  );
  await app.register(bookmarkRoutes(new BookmarkService({ bookmarks, media })));
  await app.register(
    transcriptRoutes(transcriptService(wiring, { media, diarization })),
  );
  await registerSpeakers(app, {
    deps: wiring.media,
    media,
    diarization,
    publisher,
    authors: wiring.authors,
    hasTopic: (topic) => wiring.catalog.get(topic) !== undefined,
    ...(wiring.documents && { documents: wiring.documents }),
  });
}

/** Who the voices are and the speakers of each collection (KBC-065). */
async function registerSpeakers(
  app: FastifyInstance,
  wiring: {
    deps: MediaDeps;
    media: MediaService;
    diarization: DiarizationService;
    publisher: TrackPublisher;
    authors: AuthorsService;
    hasTopic: (topic: string) => boolean;
    documents?: MediaDocuments;
  },
) {
  const { deps, authors, hasTopic } = wiring;
  const rootOf = (topic: string) => authors.rootOf(topic);
  await app.register(speakerRoutesOf(wiring));
  const service = new SpeakersService({
    speakers: deps.speakers,
    rootOf,
    authorOf: (topic, slug) => authors.authorOf(topic, slug),
    onRenamed: (collection) =>
      wiring.documents?.reconciler.reconcileTopic(collection),
  });
  await app.register(collectionSpeakerRoutes({ service, hasTopic }));
}

/** Names, with what follows from each change: tracks, words and history (KBC-090). */
function voiceNames(input: {
  deps: MediaDeps;
  media: MediaService;
  diarization: DiarizationService;
  publisher: TrackPublisher;
  authors: AuthorsService;
  rootOf: (topic: string) => string;
  speakersOf: (actor: MediaActor, mediaId: string) => MediaSpeakers;
}): VoiceNamesService {
  const { deps, media, diarization, publisher, authors } = input;
  const revisions = createTrackRevisions({
    media: deps,
    service: media,
    publisher,
    diarization,
    authors,
  });
  return new VoiceNamesService({
    ...deps,
    rootOf: input.rootOf,
    speakersOf: input.speakersOf,
    relabel: (actor, target, apply) =>
      revisions.voiceRenamed(actor, target, apply),
    onChanged: (mediaId) => publisher.afterChange(mediaId),
  });
}

/** "Vozes": names, and the answers to what is suggested by voice (KBC-065, KBC-071). */
function speakerRoutesOf(input: {
  deps: MediaDeps;
  media: MediaService;
  diarization: DiarizationService;
  publisher: TrackPublisher;
  authors: AuthorsService;
}) {
  const { deps, diarization, authors } = input;
  const rootOf = (topic: string) => authors.rootOf(topic);
  const speakersOf = (actor: MediaActor, mediaId: string) =>
    diarization.speakers(actor, mediaId);
  const names = voiceNames({ ...input, rootOf, speakersOf });
  return speakerRoutes({
    service: diarization,
    names,
    suggestions: new VoiceSuggestionService({
      profiles: deps.voiceProfiles,
      names,
      speakersOf,
    }),
  });
}

/** Voice separations (KBC-064): asked by people, done by a transcriber that separates voices. */
function diarizationService(wiring: {
  media: MediaDeps;
  transcribers: TranscriberService;
  authors: AuthorsService;
}): DiarizationService {
  const { store, files, transcripts, diarizations, voiceLabels } = wiring.media;
  return new DiarizationService({
    store,
    files,
    transcripts,
    diarizations,
    voiceLabels,
    authorOf: (topic, slug) => wiring.authors.authorOf(topic, slug),
    presence: () => wiring.transcribers.presence('diarize'),
    voicePrints: voicePrintService(wiring),
  });
}

/** The media library home of each person (KBC-051): all their collections at once. */
async function registerLibrary(
  app: FastifyInstance,
  wiring: MediaWiring & { transcribers: TranscriberService },
) {
  const { store, listening, trackLinks } = wiring.media;
  const directory = createSubjectDirectory(wiring);
  const service = new LibraryService({
    levels: mediaLevelsOf(wiring),
    store,
    listening,
    authorOf: (topic, slug) => wiring.authors.authorOf(topic, slug),
    presence: () => wiring.transcribers.presence(),
    scopeOf: (topic) =>
      wiring.catalog.scope(topic).map((one) => one.topic.slug),
    subjectsOf: (tracks) => directory.shownOn(tracks),
    speech: trackLinks,
    about: trackLinks,
  });
  await app.register(libraryRoutes(service, wiring.config.SEARCH_RATE_LIMIT));
}

/** "Transcritores" and "Termos da transcrição": what masters set up for the Mac. */
async function registerTranscribers(
  app: FastifyInstance,
  input: {
    transcribers: TranscriberService;
    media: MediaService;
    wiring: MediaWiring;
    documents: MediaDocuments;
    learning: LearningService;
  },
): Promise<TranscriberStatusBoard> {
  const { transcribers, media, wiring, learning } = input;
  await app.register(transcriberRoutes({ transcribers, media }));
  await app.register(
    termRoutes(
      new TermListService({
        transcripts: wiring.media.transcripts,
        learnedFor: (manual) => learning.learnedFor(manual),
      }),
    ),
  );
  await app.register(learningRoutes(learning));
  return registerTranscriberStatus(app, input);
}

/** A start the waker made in the last minutes, with no word since: still preparing (S-1). */
function isStarting(
  waker: TranscriberWaker | null,
  board: TranscriberStatusBoard,
): boolean {
  const at = waker?.lastStartedAt();
  return (
    at != null &&
    Date.now() - at.getTime() < STARTING_GRACE_MS &&
    !board.saidSince(at)
  );
}

/**
 * A Mac said it can publish again (KBC-117): what died of its missing kb key is queued
 * again. Its status is taken whatever happens here.
 */
function requeueAfterSetup(
  app: FastifyInstance,
  documents: MediaDocuments,
): void {
  try {
    const topics = documents.status.retryConfigurationFailures();
    if (topics.length > 0)
      app.log.info(
        { topics },
        'track documents: back in the queue, the Mac can publish again',
      );
  } catch (err) {
    app.log.error({ err }, 'track documents: could not queue them again');
  }
}

/** The transcribers' own status for masters, and "Ligar transcritor" on the Mac (KBC-114). */
async function registerTranscriberStatus(
  app: FastifyInstance,
  input: {
    transcribers: TranscriberService;
    documents: MediaDocuments;
    wiring: MediaWiring;
  },
): Promise<TranscriberStatusBoard> {
  const { transcribers, documents, wiring } = input;
  const local = wiring.media.localTranscriber;
  const kbWaiting = () => documents.status.queue().waiting;
  // The waker reads the board and the board says what the waker sees: built in this order.
  let waker: TranscriberWaker | null = null;
  const board = new TranscriberStatusBoard({
    transcribers,
    kbWaiting,
    canStartHere: local !== null,
    attention: () => waker?.attention() ?? null,
    onKbReady: () => requeueAfterSetup(app, documents),
  });
  const startingNow = () => isStarting(waker, board);
  await app.register(transcriberStatusRoutes({ board, local, startingNow }));
  waker = transcriberWaker(app, {
    ...{ local, board, kbWaiting, wiring, documents },
  });
  watchForTranscriberWork(app, waker);
  return board;
}

/** KBC-114 AC-15: the owner never starts the transcriber by hand, and only for work it takes. */
function transcriberWaker(
  app: FastifyInstance,
  input: {
    local: MediaDeps['localTranscriber'];
    board: TranscriberStatusBoard;
    kbWaiting: () => number;
    wiring: MediaWiring;
    documents: MediaDocuments;
  },
): TranscriberWaker {
  const { local, board, kbWaiting, wiring, documents } = input;
  return new TranscriberWaker({
    local,
    backlog: () => [
      ...wiring.media.store.transcriberBacklog(),
      { kind: 'kb-publish', ready: documents.kb.leasableJobs() },
    ],
    whyNot: (kind) => board.whyNot(kind),
    // Documents the ceiling holds back: no lease gives them out, so they start nothing.
    capped: () =>
      documents.kb.budgetUsd() <= 0
        ? [{ kind: 'kb-publish', ready: kbWaiting() }]
        : [],
    isOnline: () => board.anyOnline(),
    stoppedSince: (at) => board.stoppedSince(at),
    onWoken: (detail) => app.log.info({ detail }, 'transcriber: started'),
    onError: (err) => app.log.warn({ err }, 'transcriber: could not start'),
  });
}

/** Learning from word corrections (KBC-113, ADR 0037): rules, learned terms, switches. */
function learningService(
  app: FastifyInstance,
  media: MediaDeps,
): LearningService {
  return new LearningService({
    corrections: media.corrections,
    transcripts: media.transcripts,
    countTokens: countPromptTokens,
    onApplied: (event) => app.log.info(event, 'transcript.learning'),
  });
}

/** Paired transcribers and the VM's token (ADR 0023). */
function transcriberService(media: MediaDeps): TranscriberService {
  return new TranscriberService({
    store: media.transcribers,
    tokenKey: media.tokenKey,
    vmToken: media.workerToken,
  });
}

/** Track documents (KBC-099): the backstop sweep and the masters' "faixas que já existem". */
async function startDocuments(
  app: FastifyInstance,
  wiring: MediaWiring & { transcribers: TranscriberService },
): Promise<MediaDocuments> {
  const { catalog, transcribers } = wiring;
  const documents = createMediaDocuments({
    ...wiring,
    onRenderError: (mediaId, err) =>
      app.log.error({ err, mediaId }, 'track document: render failed'),
    onTopicError: (topic, err) =>
      app.log.error(
        { err, topic },
        'track documents: collection render failed',
      ),
    speakersOf: documentSpeakers(wiring),
    presence: () => transcribers.presence('kb-publish'),
  });
  startDocumentBackstop(
    app,
    documents.reconciler,
    wiring.config.KB_CHAT_RECONCILE_MS,
  );
  observeCatalog(app, { catalog, documents });
  wiring.authors.onMainChanged((topic) =>
    documents.reconciler.reconcileTopic(topic),
  );
  await app.register(existingTracksRoutes(documents.existing));
  return documents;
}

/** What the catalog sees is what production searches (KBC-100 FR-6): now and at every reload. */
function observeCatalog(
  app: FastifyInstance,
  {
    catalog,
    documents,
  }: { catalog: CatalogRegistry; documents: MediaDocuments },
): void {
  const observe = () => {
    try {
      documents.status.observe(seenIn(catalog));
    } catch (err) {
      app.log.error({ err }, 'track documents: could not mark what is live');
    }
  };
  catalog.onReload(observe);
  observe();
}

/**
 * Who speaks in each segment of a media, as a listener reads it (KBC-065: names waiting for
 * a person are not said): the document names its speakers the same way (KBC-100 FR-1).
 */
function documentSpeakers(
  wiring: MediaWiring & { transcribers: TranscriberService },
) {
  const reader = transcriptReader(wiring);
  return (mediaId: string): readonly (string | null)[] => {
    const transcript = reader.current(SYSTEM_READER, mediaId, {
      withVoices: false,
      withNames: true,
    });
    const names = new Map(
      (transcript.voiceNames ?? []).map((label) => [label.voice, label.name]),
    );
    return transcript.segments.map((segment) =>
      'voice' in segment && typeof segment.voice === 'number'
        ? (names.get(segment.voice) ?? null)
        : null,
    );
  };
}

/** The app reading its own media for the documents: any collection, nothing to upload. */
const SYSTEM_READER: MediaActor = {
  principal: 'kb-chat',
  isMaster: true,
  canUpload: false,
  canSee: () => true,
  levelsIn: () => null,
};

/** The transcripts with who speaks, as listeners get them, for any media. */
function transcriptReader(
  wiring: MediaWiring & { transcribers: TranscriberService },
): TranscriptService {
  const diarization = diarizationService(wiring);
  return new TranscriptService({
    transcripts: wiring.media.transcripts,
    // The documents are the app's own reading: any media, archived or not.
    media: { get: () => ({ archived: false }) },
    recording: wiring.media.store,
    voices: (mediaId, transcript) => diarization.voicesOn(mediaId, transcript),
    trackVoices: trackVoiceNames(wiring.media, (topic, slug) =>
      wiring.authors.authorOf(topic, slug),
    ),
  });
}

/** Where a media stands in the AI research, and **Tentar de novo** (KBC-100 FR-3). */
async function registerPublication(
  app: FastifyInstance,
  { documents, media }: { documents: MediaDocuments; media: MediaService },
): Promise<void> {
  await app.register(
    publicationRoutes({
      status: documents.status,
      findMedia: (actor, mediaId) => media.get(actor, mediaId),
    }),
  );
}

/** The media library (KBC-034, ADR 0022): people's routes, the worker's and the janitor. */
async function registerMedia(app: FastifyInstance, wiring: MediaWiring) {
  const learning = learningService(app, wiring.media);
  const transcribers = transcriberService(wiring.media);
  const groq = createGroq({ media: wiring.media, transcribers, log: app.log });
  const documents = await startDocuments(app, { ...wiring, transcribers });
  const media = mediaService({ ...wiring, transcribers, groq, documents });
  const publisher = trackPublisher(wiring, documents);
  const withDocuments = { ...wiring, documents };
  await registerPublication(app, { documents, media });
  const setup = { transcribers, media, wiring, documents, learning };
  const statusBoard = await registerTranscribers(app, setup);
  await app.register(groqRoutes({ groq, media }));
  const listeners = { media, transcribers, publisher };
  await registerListening(app, withDocuments, listeners);
  const measures = await registerMeasures(app, { deps: wiring.media, media });
  await registerLibrary(app, { ...wiring, transcribers });
  await registerVoiceProfiles(app, { ...wiring, transcribers });
  const edited = await registerEditing(app, {
    ...withDocuments,
    service: media,
    transcribers,
    publisher,
  });
  const worker = { ...measures, ...wiring, transcribers, groq, learning };
  await registerWorker(app, {
    ...{ ...worker, publisher, documents, ...edited, statusBoard },
  });
  await registerMediaRoutes(app, { wiring, media, publisher, edited });
  startJanitor(app, { ...measures, ...edited, media: wiring.media, groq });
}

/** People's routes over their media: details, the guided flow's plans, tracks. */
async function registerMediaRoutes(
  app: FastifyInstance,
  input: {
    wiring: MediaWiring;
    media: MediaService;
    publisher: TrackPublisher;
    edited: Awaited<ReturnType<typeof registerEditing>>;
  },
): Promise<void> {
  const { wiring, media, publisher, edited } = input;
  await app.register(
    mediaRoutes(media, mediaEditor({ ...wiring, publisher, log: app.log }), {
      createPerMinute: wiring.media.createPerMinute,
      plans: edited.preparation,
      tracks: edited.revisions,
    }),
  );
}

/** Proposals, the draft, subjects and the guided flow over them (KBC-066, 067, 069, 072). */
async function registerEditing(
  app: FastifyInstance,
  wiring: MediaWiring & {
    readonly service: MediaService;
    readonly transcribers: TranscriberService;
    readonly publisher: TrackPublisher;
  },
) {
  const diarization = diarizationService(wiring);
  const proposals = await registerProposals(app, { ...wiring, diarization });
  await registerEdit(app, wiring);
  const revisions = createTrackRevisions({ ...wiring, diarization });
  await app.register(trackRevisionRoutes(revisions));
  const subjects = await registerSubjects(app, wiring);
  const preparation = preparationService(app, {
    ...wiring,
    diarization,
    proposals,
  });
  await app.register(preparationRoutes(preparation));
  const corrections = await registerCorrections(app, {
    media: wiring.media,
    service: wiring.service,
    publisher: wiring.publisher,
  });
  return { proposals, preparation, subjects, revisions, corrections };
}

/** The person who asked for a plan, as they stand now (KBC-072 BR-4). */
function planActors(app: FastifyInstance, wiring: MediaWiring) {
  return async (principal: string): Promise<PlanActor | null> => {
    const { people } = wiring.auth;
    const person = (await people.list()).find(
      (one) => people.viewerOf(one).principal === principal,
    );
    if (!person) return null;
    const parentOf = app.topicParentOf ?? NO_PARENT;
    return {
      principal,
      isMaster: isMaster(person),
      canUpload: hasFeature(person, 'media-upload'),
      canSee: (topic) => canSeeTopic(person, topic, parentOf),
      // KBC-105: the person's levels as they stand now; without the gate, nothing (fail-closed).
      levelsIn: (topic) => {
        const gate = app.contentGate;
        return gate ? gate.viewFor(person, topic).allowedLevelIds() : [];
      },
      canEdit: hasFeature(person, 'media-edit'),
      canPropose: hasFeature(person, 'media-edit-ai'),
    };
  };
}

/** A collection's speakers by id, for the names on a track (KBC-065). */
function speakerNamesOf(
  wiring: MediaWiring,
  topic: string,
): ReadonlyMap<string, string> {
  const collection = wiring.authors.rootOf(topic);
  return new Map(
    wiring.media.speakers
      .list(collection)
      .map((speaker) => [speaker.id, speaker.name]),
  );
}

/** The voices as a plan sees them; the model estimates how many (KBC-064 BR-4). */
function planSeparation(media: MediaDeps, diarization: DiarizationService) {
  return {
    status: (mediaId: string) => diarization.status(mediaId),
    voicesOn: (mediaId: string, transcript: TranscriptSummary) =>
      diarization.voicesOn(mediaId, transcript),
    request: (mediaId: string) =>
      media.diarizations.requestDiarization({
        mediaId,
        jobId: randomUUID(),
        voices: null,
        now: new Date(),
      }),
    refused: (mediaId: string) => {
      const latest = media.diarizations.latest(mediaId);
      return latest ? media.voiceLabels.refusedNames(latest.id) : [];
    },
  };
}

/** The guided flow over the stages' own services (KBC-072). */
function preparationService(
  app: FastifyInstance,
  wiring: MediaWiring & {
    readonly service: MediaService;
    readonly diarization: DiarizationService;
    readonly proposals: ProposalService;
    readonly transcribers: TranscriberService;
  },
): PreparationService {
  const { media, service, proposals, transcribers } = wiring;
  return new PreparationService({
    plans: media.preparations,
    transcripts: media.transcripts,
    separation: planSeparation(media, wiring.diarization),
    edits: media.edits,
    drafts: media.trackProposals,
    findMedia: (actor, mediaId) => service.get(actor, mediaId),
    followable: (actor, mediaId) => service.followable(actor, mediaId),
    retryConversion: (actor, mediaId) => {
      service.retry(actor, mediaId);
    },
    speakerNames: (topic) => speakerNamesOf(wiring, topic),
    proposals,
    actorOf: planActors(app, wiring),
    presence: () => transcribers.presence(),
    voicePresence: () => transcribers.presence('diarize'),
    onError: (err, mediaId) =>
      app.log.warn({ err, mediaId }, 'media preparation could not go on'),
  });
}

/** What the VM worker measures on the audio: pauses (KBC-044) and peaks (KBC-066). */
async function registerMeasures(
  app: FastifyInstance,
  wiring: { deps: MediaDeps; media: MediaService },
) {
  const { deps, media } = wiring;
  const silences = new SilenceService({
    store: deps.store,
    silences: deps.silences,
    media,
  });
  await app.register(silenceRoutes(silences));
  const waveforms = new WaveformService({ waveforms: deps.waveforms, media });
  await app.register(waveformRoutes(waveforms));
  return { silences, waveforms };
}

type JanitorWiring = Parameters<typeof startJanitor>[1];

function janitorOf(app: FastifyInstance, wiring: JanitorWiring): MediaJanitor {
  const { store, files } = wiring.media;
  return new MediaJanitor({
    store,
    files,
    log: app.log,
    backfillSilences: () => wiring.silences.backfill(),
    backfillWaveforms: () => wiring.waveforms.backfill(),
    advancePreparations: () => wiring.preparation.advanceAll(),
    purgeTrackFiles: () => wiring.revisions.purge(),
    routeToGroq: () => wiring.groq.sweep(),
  });
}

/** The queue's janitor, which also backfills silence maps (KBC-044 FR-2) and peaks. */
function startJanitor(
  app: FastifyInstance,
  wiring: {
    media: MediaDeps;
    silences: SilenceService;
    waveforms: WaveformService;
    proposals: ProposalService;
    preparation: PreparationService;
    subjects: SubjectProposalService;
    revisions: TrackRevisionService;
    groq: GroqService;
  },
): void {
  const { store } = wiring.media;
  const { proposals, subjects } = wiring;
  const janitor = janitorOf(app, wiring);
  janitor.start(JANITOR_INTERVAL_MS);
  app.addHook('onClose', async () => {
    // Runs in flight end as interrupted before the database closes.
    await proposals.stop();
    await subjects.stop();
    janitor.stop();
    store.close();
  });
}

/** The AI's track proposals (KBC-067): runs a restart cut short end first, then the routes. */
async function registerProposals(
  app: FastifyInstance,
  wiring: MediaWiring & {
    readonly service: MediaService;
    readonly diarization: DiarizationService;
  },
): Promise<ProposalService> {
  const proposals = createTrackProposals({
    ...wiring,
    findMedia: (actor, mediaId) => wiring.service.getRecording(actor, mediaId),
    log: app.log,
  });
  const interrupted = proposals.recover();
  if (interrupted > 0)
    app.log.warn({ interrupted }, 'track proposals interrupted by a restart');
  await app.register(trackProposalRoutes(proposals));
  return proposals;
}

/** A track's subjects (KBC-069): runs a restart cut short end first, then the routes. */
async function registerSubjects(
  app: FastifyInstance,
  wiring: MediaWiring & { readonly service: MediaService },
): Promise<SubjectProposalService> {
  const { subjects, proposals, suggestions } = createTrackSubjects({
    ...wiring,
    log: app.log,
  });
  const interrupted = proposals.recover();
  if (interrupted > 0)
    app.log.warn({ interrupted }, 'subject runs interrupted by a restart');
  await app.register(
    trackSubjectRoutes({
      subjects,
      proposals,
      suggestions,
      hasTopic: (topic) => wiring.catalog.get(topic) !== undefined,
    }),
  );
  return proposals;
}

/** The draft of a recording's tracks, its approval and the approved tracks (KBC-066). */
async function registerEdit(
  app: FastifyInstance,
  wiring: MediaWiring & {
    readonly service: MediaService;
    readonly publisher: TrackPublisher;
  },
): Promise<void> {
  const { edits, trackProposals, transcripts, speakers, preparations } =
    wiring.media;
  await app.register(
    mediaEditRoutes(
      new TrackEditService({
        edits,
        drafts: trackProposals,
        transcripts,
        speakers,
        plans: preparations,
        rootOf: (topic) => wiring.authors.rootOf(topic),
        findMedia: (actor, mediaId) => wiring.service.get(actor, mediaId),
        publisher: wiring.publisher,
        preparation: wiring.media.trackItems,
      }),
    ),
  );
}

/** The one-time codes, access requests and messages of KBC-014 (ADR 0011). */
function buildAccess(deps: FullDeps) {
  const { access, auth, config } = deps;
  const notifier = new Notifier({
    ...access.delivery,
    webOrigin: config.WEB_ORIGIN,
  });
  const codes = new OneTimeCodes({ store: access.codes });
  const requests = new AccessRequestService({
    store: access.requests,
    people: auth.people,
  });
  const flow = new SignUpFlow({
    requests,
    people: auth.people,
    codes,
    notifier,
  });
  return {
    notifier,
    codes,
    requests,
    flow,
    tickets: new RequestTickets(),
    limits: new SendLimits(),
  };
}

/** Sign-in, who is signed in and "Pessoas e permissões" (KBC-010, ADR 0008; KBC-014). */
/** The act-as audit keeps 12 months (ADR 0027): pruned at start and once a day. */
function pruneActAsAudit(app: FastifyInstance, actAs: ActAsService): void {
  const prune = () =>
    actAs.prune().catch((err: unknown) => app.log.warn({ err }, 'audit prune'));
  void prune();
  const timer = setInterval(prune, 24 * 60 * 60_000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
}

async function registerAuth(app: FastifyInstance, deps: FullDeps) {
  const { config, catalog, auth } = deps;
  const topics = () => catalog.topics().map(({ topic }) => topic.slug);
  const access = buildAccess(deps);
  await app.register(
    authRoutes({
      ...auth,
      topics,
      googleClientId: config.GOOGLE_CLIENT_ID ?? null,
      loginRatePerMinute: config.AUTH_RATE_LIMIT,
      codeChannels: access.notifier.smsEnabled ? ['email', 'sms'] : ['email'],
      privacyContactEmail: config.KB_CHAT_OWNER_EMAIL ?? null,
      mediaEnabled: deps.media !== undefined,
      notInvited: async (identity) => ({
        ticket: access.tickets.issue(identity),
        request: await access.requests.stateFor(identity),
      }),
    }),
  );
  await app.register(actAsRoutes(auth.actAs));
  pruneActAsAudit(app, auth.actAs);
  // KBC-026: inviting sends an e-mail through the same notifier as the codes.
  const invitations = new Invitations({
    people: auth.people,
    notifier: access.notifier,
  });
  await registerPeople(app, { deps, topics, invitations });
  await app.register(invitationRoutes({ people: auth.people, invitations }));
  await registerHouse(app, { house: deps.house, ai: deps.ai });
  await registerAccess(app, { deps, access, topics });
}

/** "Pessoas e permissões", with the house reacting to AI changes (KBC-022). */
async function registerPeople(
  app: FastifyInstance,
  wiring: {
    deps: FullDeps;
    topics: () => string[];
    invitations: Invitations;
  },
) {
  const { deps, topics, invitations } = wiring;
  const { house, auth } = deps;
  const profiles = await loadInviteProfiles(deps, (message) =>
    app.log.warn(message),
  );
  await app.register(
    peopleRoutes({
      ...auth,
      topics,
      invitations,
      ai: {
        sync: (person, ai) => house.service.syncPersonKey(person, ai),
        setDefault: (appAi, by) => house.service.setDefault(appAi, by),
      },
      presets: presetsOf(deps, profiles),
      levels: deps.levels.service,
    }),
  );
  await app.register(inviteProfilesRoutes(profiles, topics));
}

/** What an invitation and "Aplicar perfil" need from the profiles and Settings (KBC-028). */
const presetsOf = (deps: FullDeps, profiles: InviteProfilesService) => ({
  presetFor: (request: Parameters<InviteProfilesService['presetFor']>[0]) =>
    profiles.presetFor(request),
  hasSavedSettings: (person: StoredPerson) =>
    deps.ai.settings.exists(deps.auth.people.viewerOf(person).principal),
});

/** "Perfis de convite" (KBC-028): invite-profiles.json in the state folder. */
async function loadInviteProfiles(
  deps: FullDeps,
  warn: (message: string) => void,
) {
  const profiles = new InviteProfilesService({
    warn,
    store: new JsonDocumentStore(
      join(deps.config.KB_CHAT_STATE_DIR, 'invite-profiles.json'),
    ),
  });
  await profiles.load();
  return profiles;
}

/** What the owner's subscriptions can do now, for "IA da aplicação" (KBC-024, KBC-027). */
const subscriptionState = (ai: AiProviders) => ({
  lendable: () => ({
    'claude-subscription': ai.lent['claude-subscription'].available(),
    'chatgpt-subscription': ai.lent['chatgpt-subscription'].available(),
  }),
  codex: () => ai.registry.codexStatus(),
});

/** "IA da aplicação", the OpenRouter connection and the free models (KBC-022). */
async function registerHouse(
  app: FastifyInstance,
  { house, ai }: { house: HouseAi; ai: AiProviders },
) {
  const { settings } = ai;
  await app.register(
    houseAiRoutes({
      ...subscriptionState(ai),
      house: house.service,
      catalog: house.catalog,
      connect: house.connect,
      exchange: (code, verifier) => house.account.exchangeCode(code, verifier),
      targets: {
        house: {
          allowed: (viewer) => viewer.person.role === 'master',
          store: (key, viewer) =>
            house.service.connect(key, viewer.person.email),
        },
        // One's own OpenRouter (KBC-023): stored sealed in the person's settings.
        own: {
          allowed: (viewer) => hasFeature(viewer.person, 'own-ai-settings'),
          store: async (key, viewer) => {
            await settings.connectOpenRouter(viewer.principal, key);
          },
        },
      },
    }),
  );
}

/** One-time code sign-in and access requests (KBC-014, ADR 0011). */
async function registerAccess(
  app: FastifyInstance,
  wiring: {
    deps: FullDeps;
    access: ReturnType<typeof buildAccess>;
    topics: () => string[];
  },
) {
  const { deps, access, topics } = wiring;
  const rate = deps.config.AUTH_RATE_LIMIT;
  await app.register(
    codeRoutes({
      ...deps.auth,
      ...access,
      topics,
      verifyRatePerMinute: rate,
      mediaEnabled: deps.media !== undefined,
    }),
  );
  await app.register(
    accessRequestRoutes({
      ...access,
      people: deps.auth.people,
      ratePerMinute: rate,
    }),
  );
}

/** Settings, providers and the MCP endpoint of subscription turns (KBC-007, ADR 0007). */
async function registerSettings(
  app: FastifyInstance,
  ai: AiProviders,
  mcpPeers: readonly string[],
): Promise<void> {
  await app.register(
    settingsRoutes({ settings: ai.settings, providers: ai.registry }),
  );
  await app.register(mcpRoutes(ai.turns, { peers: mcpPeers }));
}

/** Settings in memory and providers from the environment only (tests). */
const inMemoryAi = (
  config: AppConfig,
  wiring: {
    agent: ResearchAgent;
    house: HouseAi;
    auth: AuthDeps;
    ledger: SpendLedgerPort;
  },
): Promise<AiProviders> =>
  createAiProviders({
    config,
    store: new MemorySettingsStore(),
    principal: OWNER,
    env: {},
    tools: wiring.agent.toolsFor,
    perTokenRunner: wiring.agent.perTokenRunner,
    systemPrompt: wiring.agent.systemPrompt,
    house: wiring.house,
    personOf: (principal) => wiring.auth.people.cachedByPrincipal(principal),
    ledger: wiring.ledger,
  });

/** OpenRouter never answers in a test that did not bring its own fake. */
const offline: typeof fetch = async () => {
  throw new Error('No network in tests');
};

const inMemoryHouse = (config: AppConfig): Promise<HouseAi> =>
  createHouseAi({
    sealer: new SecretBox(randomBytes(32)),
    webOrigin: config.WEB_ORIGIN,
    fetch: offline,
  });

const inMemoryAuth = (config: AppConfig): AuthDeps => ({
  people: new PeopleService({
    store: new MemoryPeopleStore(),
    ownerEmail: config.KB_CHAT_OWNER_EMAIL,
  }),
  sessions: new SessionService({ store: new MemorySessionStore() }),
  verifier: createGoogleVerifier(config.GOOGLE_CLIENT_ID ?? ''),
});

const inMemoryAccess = (): AccessDeps => ({
  codes: new MemoryDocumentStore(),
  requests: new MemoryDocumentStore(),
  delivery: { email: new MemoryOutbox(), sms: null },
});

/** The registry and the vault seen through it (ADR 0028); in memory when not given. */
function withCollections(
  given: AppDeps,
): AppDeps & { collections: CollectionRegistry } {
  if (given.collections) return { ...given, collections: given.collections };
  const collections = new CollectionRegistry(new MemoryDocumentStore());
  const vault = new CollectionsVault(given.vault, collections);
  return { ...given, vault, collections };
}

async function loadedCatalog(vault: VaultReaderPort): Promise<CatalogRegistry> {
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  return catalog;
}

/**
 * The authors of each collection (KBC-049), loaded and seeded once with the legacy main
 * author where documents or media are his (BR-4); in memory when not given.
 */
async function loadedAuthors(
  given: AppDeps,
  catalog: CatalogRegistry,
): Promise<{ authors: AuthorsService; seeded: readonly string[] }> {
  const directory =
    given.authorDirectory ?? new AuthorDirectory(new MemoryDocumentStore());
  await directory.load();
  const authors = new AuthorsService({ directory, catalog });
  const store = given.media?.store;
  const seeded = await seedLegacyAuthors({
    directory,
    authors,
    catalog,
    ...(store && {
      mediaTopicsOfLegacyAuthor: () =>
        store.topicsWithAuthor(LEGACY_MAIN_AUTHOR.slug),
    }),
  });
  return { authors, seeded };
}

/**
 * What the legacy seed did (ND-14): the collections it gave "Mestre Laércio", and a warning
 * when the vault had no collection at all (the seed then has nothing to look at).
 */
function logLegacySeed(app: FastifyInstance, deps: FullDeps): void {
  if (deps.legacySeeded.length > 0)
    app.log.info({ seeded: deps.legacySeeded }, 'legacy main author seeded');
  if (deps.catalog.topics().length === 0)
    app.log.warn(
      'the vault has no collection: the legacy author seed found none',
    );
}

/** The research agent over this catalog, naming each collection's main author. */
const agentOf = (
  deps: AppDeps,
  built: Pick<FullDeps, 'catalog' | 'ledger' | 'authors'>,
): ResearchAgent =>
  createResearchAgent({
    catalog: built.catalog,
    index: deps.index,
    vault: deps.vault,
    ledger: built.ledger,
    budgets: budgetsFromConfig(deps.config),
    mainAuthorOf: (topic) => built.authors.mainVoiceOf(topic),
  });

/** Fills what the caller left out: in-memory stores, the agent and the providers. */
async function completeDeps(given: AppDeps): Promise<FullDeps> {
  const deps = withCollections(given);
  const catalog = deps.catalog ?? (await loadedCatalog(deps.vault));
  const { authors, seeded } = await loadedAuthors(deps, catalog);
  const ledger = deps.ledger ?? new MemorySpendLedger();
  const agent = deps.agent ?? agentOf(deps, { catalog, ledger, authors });
  const auth = withActAs(deps.auth ?? inMemoryAuth(deps.config));
  const house = deps.house ?? (await inMemoryHouse(deps.config));
  return {
    ...deps,
    auth,
    house,
    access: deps.access ?? inMemoryAccess(),
    ai:
      deps.ai ??
      (await inMemoryAi(deps.config, { agent, house, auth, ledger })),
    agent,
    catalog,
    authors,
    levels: await loadedLevels(deps, {
      catalog,
      people: auth.people,
      media: deps.media?.store,
    }),
    legacySeeded: seeded,
    ledger,
    usage: deps.usage ?? new MemoryUsageLog(),
    conversations: deps.conversations ?? new MemoryConversationStore(),
  };
}

/** The scales and levels (KBC-103), loaded, with the gate every content route asks. */
async function loadedLevels(
  given: AppDeps,
  built: {
    catalog: CatalogRegistry;
    people: PeopleService;
    media: Pick<MediaStorePort, 'seedLevel'> | undefined;
  },
): Promise<FullDeps['levels']> {
  const levels = given.levels ?? inMemoryLevels();
  await levels.directory.load();
  const { catalog, people, media } = built;
  const gate = new ContentGate({ directory: levels.directory, catalog });
  const parentOf = (slug: string) => catalog.get(slug)?.topic.parent ?? null;
  // One queue for both services: a scale change never slips into a document write (R1-7).
  const queue = new LevelWriteQueue();
  const shared = { ...levels, catalog, gate, parentOf, queue };
  const service = new AccessLevelsService({
    ...shared,
    people,
    ...(media && { media }),
  });
  const documents = new DocumentLevelsService(shared);
  return { ...levels, gate, service, documents };
}

/** The levels' state in memory (tests, and an app built without a state folder). */
const inMemoryLevels = (): LevelDeps => ({
  directory: new LevelDirectory({
    scales: new MemoryDocumentStore(),
    documents: new MemoryDocumentStore(),
    presence: new MemoryDocumentStore(),
  }),
  audit: new MemoryLevelAudit(),
});

/** Acting as a person (KBC-060): its audit in memory unless main gave one on disk. */
function withActAs(auth: AuthDeps): AuthDeps & { actAs: ActAsService } {
  return {
    ...auth,
    actAs:
      auth.actAs ??
      new ActAsService({
        sessions: auth.sessions,
        people: auth.people,
        audit: new MemoryActAsAudit(),
      }),
  };
}

/**
 * The collection tree for every access check (ADR 0028): a parent's grant reaches its
 * sub-collections, by the catalog, never by the slug's text; and the gate every content
 * route asks for the person's view of a collection (ADR 0036 §7).
 */
function decorateTrees(app: FastifyInstance, full: FullDeps): void {
  app.decorate(
    'topicParentOf',
    (slug: string) => full.catalog.get(slug)?.topic.parent ?? null,
  );
  app.decorate('contentGate', full.levels.gate);
  app.decorate('levelHooks', full.levels.gate);
}

/** Assembles the API; only `main` listens (ND-01). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const full = await completeDeps(deps);
  const app = Fastify({
    // Document ids are vault paths; Fastify's default (100 characters) refused 104 real ones.
    maxParamLength: 1024,
    // Behind the reverse proxy (ADR 0010), request.ip comes from X-Forwarded-For.
    trustProxy: deps.config.TRUST_PROXY ?? false,
    loggerInstance: deps.logger ?? createLogger(deps.config.LOG_LEVEL),
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);
  decorateTrees(app, full);
  // KBC-105 AC-10: the audios of a collection that had a scale before media held a level.
  await full.levels.service.seedMediaAtStart(app.log);
  // KBC-107 FR-5: what each catalog load brought or took, for the "Sem nível" queue.
  await full.levels.documents.reconcile(app.log);
  full.catalog.onReload(() => void full.levels.documents.reconcile(app.log));

  // The Codex sandbox reaches only the MCP routes (KBC-027, ADR 0020).
  app.addHook('onRequest', peerOnlyMcp(deps.config.KB_CHAT_MCP_PEERS));
  await app.register(routeAccess);
  await app.register(hostGuard, { allowedHosts: deps.config.ALLOWED_HOSTS });
  await app.register(cors, { origin: [deps.config.WEB_ORIGIN] });
  await app.register(csrfGuard, { webOrigin: deps.config.WEB_ORIGIN });
  await app.register(authGuard, full.auth);
  // The signed-in person's settings are in memory before any route reads them.
  app.addHook('preHandler', async (request) => {
    if (request.viewer) await full.ai.settings.load(request.viewer.principal);
  });
  await app.register(rateLimit, { global: false });
  await registerRoutes(app, full);
  logLegacySeed(app, full);

  app.addHook('onClose', async () => deps.index.close());
  return app;
}
