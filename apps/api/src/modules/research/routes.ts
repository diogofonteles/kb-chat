import {
  researchRequestSchema,
  topicSlugSchema,
  type ResearchEvent,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { ResearchRunnerPort } from '../../ports/research-runner.js';

export interface ResearchRouteOptions {
  /**
   * The runner of this turn, asked again on every request: the provider in Settings may
   * have changed since the last one (KBC-007 FR-5).
   */
  readonly runner: () => ResearchRunnerPort;
  /** False for a topic the catalog does not know (refused before streaming). */
  readonly hasTopic: (topic: string) => boolean;
}

/** Each answer may cost money: a low per-client rate (ND-22). */
const RATE_PER_MINUTE = 20;

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

const researchOptions = {
  config: { rateLimit: { max: RATE_PER_MINUTE, timeWindow: '1 minute' } },
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
    const input = { topic, ...body, signal };
    for await (const event of runner.run(input)) send(event);
  } catch (err) {
    request.log.error({ err }, 'research stream failed');
    const code = err instanceof AppError ? err.code : 'INTERNAL';
    send({ type: 'error', code });
  }
  reply.raw.end();
}

export const researchRoutes =
  ({ runner, hasTopic }: ResearchRouteOptions): FastifyPluginAsync =>
  async (app) => {
    app
      .withTypeProvider<ZodTypeProvider>()
      .post(
        '/api/v1/topics/:topic/research',
        researchOptions,
        async (request, reply) => {
          const { topic } = request.params;
          const current = runner();
          if (!current.configured())
            throw new AppError(
              'LLM_NOT_CONFIGURED',
              'No AI provider configured',
            );
          if (!hasTopic(topic))
            throw new AppError('TOPIC_NOT_FOUND', `Unknown topic ${topic}`);
          const call = { topic, body: request.body };
          return streamResearch(current, call, { request, reply });
        },
      );
  };
