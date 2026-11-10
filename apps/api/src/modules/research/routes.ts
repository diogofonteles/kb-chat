import { finished } from 'node:stream/promises';
import {
  researchRequestSchema,
  topicSlugSchema,
  type ResearchEvent,
  type ResearchProfile,
  type SavedResearchTurn,
} from '@kb-chat/contracts';
import type {
  FastifyBaseLogger,
  FastifyInstance,
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { LevelView } from '../../ports/level-view.js';
import type { ResearchRunnerPort } from '../../ports/research-runner.js';
import type { TrackShelf } from '../../ports/track-shelf.js';
import { levelViewOf } from '../access-levels/index.js';
import {
  hasFeature,
  principalOf,
  viewerOf,
  type RouteAccess,
} from '../auth/index.js';
import type { LiveTurn, LiveTurns } from './live-turns.js';
import { pendingTurn, recordTurn } from './turn-record.js';

export interface ResearchRouteOptions {
  /**
   * The runner of this turn, asked again on every request: the provider in Settings may
   * have changed since the last one (KBC-007 FR-5), and each profile has its model (KBC-011).
   * The turn runs as the signed-in person: their provider, key, cap and ledger (KBC-010).
   */
  readonly runner: (
    principal: string,
    profile: ResearchProfile,
  ) => ResearchRunnerPort;
  /** False for a topic the catalog does not know (refused before streaming). */
  readonly hasTopic: (topic: string) => boolean;
  /** The recorded turns running now (KBC-029). */
  readonly turns: LiveTurns;
  /** Where a recorded turn is written as it starts and ends (the conversation history). */
  readonly journal: TurnJournal;
  /** Research turns per minute per client (RESEARCH_RATE_LIMIT). */
  readonly ratePerMinute: number;
  /** A turn's view of media.db (KBC-099), when the media library is on. */
  readonly shelf?: () => TrackShelf;
}

/**
 * The tracks a turn may see (KBC-099 BR-4, FR-10): the route already checked the collection
 * and `research`; the person (the one a master acts as, in "Ver como") also needs `media`
 * and `media-research`, and `media-tracks`, without which a track item does not exist for
 * them (KBC-068 FR-5): a citation they could not open is never given.
 */
function shelfFor(
  request: FastifyRequest,
  shelf: (() => TrackShelf) | undefined,
): TrackShelf | undefined {
  const { person } = viewerOf(request);
  const allowed = (['media', 'media-tracks', 'media-research'] as const).every(
    (feature) => hasFeature(person, feature),
  );
  return allowed ? shelf?.() : undefined;
}

/**
 * Who the turn reads for (the one a master acts as): their view of the collection, which
 * every tool, the sweep and a cursor sent back go through (KBC-104 BR-1), and their tracks.
 */
function readerOf(
  request: FastifyRequest,
  topic: string,
  shelf: (() => TrackShelf) | undefined,
): Pick<ResearchCall, 'view' | 'tracks'> {
  const tracks = shelfFor(request, shelf);
  return { view: levelViewOf(request, topic), ...(tracks && { tracks }) };
}

/** The history as the research routes write to it (KBC-029); the conversations module. */
export interface TurnJournal {
  beginTurn(
    principal: string,
    place: {
      readonly conversationId: string;
      readonly topic: string;
      readonly turn: SavedResearchTurn;
    },
  ): Promise<void>;
  finishTurn(
    principal: string,
    conversationId: string,
    turn: SavedResearchTurn,
  ): Promise<void>;
}

/** Following or stopping a turn costs nothing, but each holds a stream or a turn. */
const TURN_RATE_PER_MINUTE = 60;

function openStream(reply: FastifyReply): (event: ResearchEvent) => void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  return (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Aborts the agent when the client goes away (the body was read, so only the response tells). */
function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  return abort.signal;
}

/** The collection and "Pesquisa com IA" (KBC-010). */
const RESEARCH_ACCESS: RouteAccess = {
  topicParam: 'topic',
  feature: 'research',
};

/** Each answer may cost money: a low per-client rate (ND-22, RESEARCH_RATE_LIMIT). */
const researchOptions = (ratePerMinute: number) => ({
  config: {
    access: RESEARCH_ACCESS,
    rateLimit: { max: ratePerMinute, timeWindow: '1 minute' },
  },
  schema: {
    params: z.object({ topic: topicSlugSchema }),
    body: researchRequestSchema,
  },
});

export interface ResearchCall {
  readonly topic: string;
  readonly body: ResearchRequestBody;
  /** The tracks this person may research; none without the permissions. */
  readonly tracks?: TrackShelf;
  /** What the person (the one a master acts as) may see of the collection (KBC-104). */
  readonly view: LevelView;
}

type ResearchRequestBody = z.output<typeof researchRequestSchema>;

/** Streams one research turn as SSE; a failure becomes an `error` event. */
async function streamResearch(
  runner: ResearchRunnerPort,
  call: ResearchCall,
  { request, reply }: { request: FastifyRequest; reply: FastifyReply },
): Promise<void> {
  const signal = abortOnDisconnect(reply);
  const send = openStream(reply);
  send({ type: 'start', model: runner.model, billing: runner.billing });
  try {
    for await (const event of runner.run(inputOf(call, signal)))
      send(withPlan(event));
  } catch (err) {
    request.log.error({ err }, 'research stream failed');
    send(failure(err));
  }
  reply.raw.end();
}

const inputOf = (
  { topic, body, tracks, view }: ResearchCall,
  signal: AbortSignal,
) => ({
  topic,
  view,
  ...(tracks && { tracks }),
  question: body.question,
  history: body.history,
  profile: body.profile,
  // "Continuar varredura" (KBC-030): the sweep resumes from the page's cursor.
  ...(body.sweep && { sweep: body.sweep }),
  signal,
});

/** A turn no app AI paid for is the person's own (KBC-022 transparency). */
const withPlan = (event: ResearchEvent): ResearchEvent =>
  event.type === 'done' && !event.plan ? { ...event, plan: 'own' } : event;

const failure = (err: unknown): ResearchEvent => ({
  type: 'error',
  code: err instanceof AppError ? err.code : 'INTERNAL',
});

/** Streams a running turn's events to this request until the turn ends or the page leaves. */
export async function followTurn(
  reply: FastifyReply,
  turn: LiveTurn,
): Promise<void> {
  // The page may leave while the turn is being saved: the turn goes on, nobody to stream to.
  if (reply.raw.destroyed) {
    reply.hijack();
    return;
  }
  const send = openStream(reply);
  const closed = finished(reply.raw).catch(() => undefined);
  const unfollow = turn.follow({ event: send, end: () => reply.raw.end() });
  await closed;
  unfollow();
}

export interface RecordedCall extends ResearchCall {
  readonly principal: string;
  readonly conversationId: string;
  readonly turnId: string;
}

export interface Recording {
  readonly runner: ResearchRunnerPort;
  readonly call: RecordedCall;
  readonly turn: LiveTurn;
  readonly pending: SavedResearchTurn;
  readonly log: FastifyBaseLogger;
}

/**
 * Runs a recorded turn to its end apart from any connection (KBC-029): only "Parar" or the
 * ceiling stop it. Its outcome is written to the history; it never throws.
 */
export async function runRecorded(
  { runner, call, turn, pending, log }: Recording,
  { journal, turns }: Pick<ResearchRouteOptions, 'journal' | 'turns'>,
): Promise<void> {
  turn.publish({ type: 'start', model: runner.model, billing: runner.billing });
  try {
    for await (const event of runner.run(inputOf(call, turn.abort.signal)))
      turn.publish(withPlan(event));
  } catch (err) {
    log.error({ err }, 'recorded research turn failed');
    turn.publish(failure(err));
  }
  // A retry that took this turn id over records its own outcome (no clocks involved).
  if (turns.find(call.principal, call.turnId) === turn)
    await journal
      .finishTurn(
        call.principal,
        call.conversationId,
        recordTurn(pending, turn.events),
      )
      .catch((err: unknown) =>
        log.error({ err }, 'cannot record a research turn'),
      );
  turns.end(turn);
}

/**
 * Registers the turn, then records it as pending. Registered first: from then on an older
 * attempt of this turn id no longer records its end, and the person's turn still running in
 * this conversation is stopped (one at a time), even if the history then refuses this one
 * (another person's conversation, another collection), which is the page's own mistake.
 */
async function claimTurn(
  { journal, turns }: Pick<ResearchRouteOptions, 'journal' | 'turns'>,
  { principal, conversationId, turnId, topic }: RecordedCall,
  pending: SavedResearchTurn,
): Promise<LiveTurn> {
  const turn = turns.start({ principal, conversationId, turnId });
  try {
    await journal.beginTurn(principal, {
      conversationId,
      topic,
      turn: pending,
    });
    return turn;
  } catch (err) {
    turns.end(turn);
    throw err;
  }
}

/** Records the turn as pending, starts it and follows it on this request. */
async function startRecorded(
  runner: ResearchRunnerPort,
  call: RecordedCall,
  ctx: {
    reply: FastifyReply;
    log: FastifyBaseLogger;
    options: ResearchRouteOptions;
  },
): Promise<void> {
  const pending = pendingTurn({
    ...call.body,
    id: call.turnId,
    at: new Date().toISOString(),
  });
  const turn = await claimTurn(ctx.options, call, pending);
  const recording = { runner, call, turn, pending, log: ctx.log };
  ctx.options.turns.track(runRecorded(recording, ctx.options));
  await followTurn(ctx.reply, turn);
}

/** One research turn: recorded in the history when the page sent its ids (KBC-029). */
async function handleResearch(
  options: ResearchRouteOptions,
  { topic, body }: Pick<ResearchCall, 'topic' | 'body'>,
  { request, reply }: { request: FastifyRequest; reply: FastifyReply },
): Promise<void> {
  const principal = principalOf(request);
  const current = options.runner(principal, body.profile);
  if (!current.configured())
    throw new AppError('LLM_NOT_CONFIGURED', 'No AI provider configured');
  if (!options.hasTopic(topic))
    throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
  const { conversationId, turnId } = body;
  const own = { topic, body, ...readerOf(request, topic, options.shelf) };
  if (!conversationId || !turnId)
    return streamResearch(current, own, { request, reply });
  const call = { ...own, principal, conversationId, turnId };
  return startRecorded(current, call, { reply, log: request.log, options });
}

const turnParams = z.object({ turnId: z.uuid() });

const turnOptions = {
  config: {
    access: { feature: 'research' } satisfies RouteAccess,
    rateLimit: { max: TURN_RATE_PER_MINUTE, timeWindow: '1 minute' },
  },
};

/** Follow a running turn again (a reload) and "Parar" (KBC-029). */
function registerTurnRoutes(app: FastifyInstance, turns: LiveTurns): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.get(
    '/api/v1/research/turns/:turnId/events',
    { ...turnOptions, schema: { params: turnParams } },
    async (request, reply) => {
      const turn = turns.find(principalOf(request), request.params.turnId);
      if (!turn) throw new AppError('NOT_FOUND', 'No such running turn');
      return followTurn(reply, turn);
    },
  );
  typed.post(
    '/api/v1/research/turns/:turnId/stop',
    {
      ...turnOptions,
      schema: { params: turnParams, response: { 204: z.undefined() } },
    },
    // Idempotent: a turn that already ended (or never ran) is not an error.
    async (request, reply) => {
      turns.stop(principalOf(request), request.params.turnId);
      return reply.code(204).send();
    },
  );
}

export const researchRoutes =
  (options: ResearchRouteOptions): FastifyPluginAsync =>
  async (app) => {
    registerTurnRoutes(app, options.turns);
    app
      .withTypeProvider<ZodTypeProvider>()
      .post(
        '/api/v1/topics/:topic/research',
        researchOptions(options.ratePerMinute),
        (request, reply) => {
          return handleResearch(
            options,
            { topic: request.params.topic, body: request.body },
            { request, reply },
          );
        },
      );
  };
