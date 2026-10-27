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
import type { ResearchRunnerPort } from '../../ports/research-runner.js';
import { principalOf, type RouteAccess } from '../auth/index.js';
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

/** Each answer may cost money: a low per-client rate (ND-22). */
const RATE_PER_MINUTE = 20;
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

const researchOptions = {
  config: {
    access: RESEARCH_ACCESS,
    rateLimit: { max: RATE_PER_MINUTE, timeWindow: '1 minute' },
  },
  schema: {
    params: z.object({ topic: topicSlugSchema }),
    body: researchRequestSchema,
  },
};

interface ResearchCall {
  readonly topic: string;
  readonly body: ResearchRequestBody;
}

type ResearchRequestBody = z.output<typeof researchRequestSchema>;

/** Streams one research turn as SSE; a failure becomes an `error` event. */
async function streamResearch(
  runner: ResearchRunnerPort,
  { topic, body }: ResearchCall,
  { request, reply }: { request: FastifyRequest; reply: FastifyReply },
): Promise<void> {
  const signal = abortOnDisconnect(reply);
  const send = openStream(reply);
  send({ type: 'start', model: runner.model, billing: runner.billing });
  try {
    for await (const event of runner.run(inputOf({ topic, body }, signal)))
      send(withPlan(event));
  } catch (err) {
    request.log.error({ err }, 'research stream failed');
    send(failure(err));
  }
  reply.raw.end();
}

const inputOf = ({ topic, body }: ResearchCall, signal: AbortSignal) => ({
  topic,
  question: body.question,
  history: body.history,
  profile: body.profile,
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
async function followTurn(reply: FastifyReply, turn: LiveTurn): Promise<void> {
  const send = openStream(reply);
  const closed = new Promise<void>((resolve) => reply.raw.on('close', resolve));
  const unfollow = turn.follow({ event: send, end: () => reply.raw.end() });
  await closed;
  unfollow();
}

interface RecordedCall extends ResearchCall {
  readonly principal: string;
  readonly conversationId: string;
  readonly turnId: string;
}

interface Recording {
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
async function runRecorded(
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
  const outcome = recordTurn(pending, turn.events);
  await journal
    .finishTurn(call.principal, call.conversationId, outcome)
    .catch((err: unknown) =>
      log.error({ err }, 'cannot record a research turn'),
    );
  turns.end(turn);
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
  const { journal, turns } = ctx.options;
  const { principal, conversationId, turnId, topic, body } = call;
  const pending = pendingTurn({
    id: turnId,
    question: body.question,
    profile: body.profile,
    at: new Date().toISOString(),
  });
  // Refused (another person's conversation, another collection) before anything runs.
  await journal.beginTurn(principal, { conversationId, topic, turn: pending });
  const turn = turns.start({ principal, conversationId, turnId });
  const recording = { runner, call, turn, pending, log: ctx.log };
  turns.track(runRecorded(recording, ctx.options));
  await followTurn(ctx.reply, turn);
}

/** One research turn: recorded in the history when the page sent its ids (KBC-029). */
async function handleResearch(
  options: ResearchRouteOptions,
  { topic, body }: ResearchCall,
  { request, reply }: { request: FastifyRequest; reply: FastifyReply },
): Promise<void> {
  const principal = principalOf(request);
  const current = options.runner(principal, body.profile);
  if (!current.configured())
    throw new AppError('LLM_NOT_CONFIGURED', 'No AI provider configured');
  if (!options.hasTopic(topic))
    throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
  const { conversationId, turnId } = body;
  if (!conversationId || !turnId)
    return streamResearch(current, { topic, body }, { request, reply });
  const call = { topic, body, principal, conversationId, turnId };
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
        researchOptions,
        (request, reply) =>
          handleResearch(
            options,
            { topic: request.params.topic, body: request.body },
            { request, reply },
          ),
      );
  };
