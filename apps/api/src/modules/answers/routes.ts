import {
  answerEstimateSchema,
  answerRequestSchema,
  spendTodaySchema,
  topicSlugSchema,
  type AnswerEvent,
  type AnswerRequest,
} from '@kb-chat/contracts';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { AnswersService, PreparedAnswer } from './answers-service.js';

export interface AnswerRouteOptions {
  readonly service: AnswersService;
  readonly spendToday: () => Promise<{
    usd: number;
    capUsd: number;
    configured: boolean;
  }>;
}

const topicParams = z.object({ topic: topicSlugSchema });
const estimateOptions = {
  config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
};
const estimateSchema = {
  params: topicParams,
  body: answerRequestSchema,
  response: { 200: answerEstimateSchema },
};
const spendSchema = { response: { 200: spendTodaySchema } };
const answerHeaders = z.looseObject({
  'idempotency-key': z.string().min(8).max(100),
});

function openStream(reply: FastifyReply): (event: AnswerEvent) => void {
  reply.hijack();
  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  return (event) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
}

interface AnswerCall {
  readonly topic: string;
  readonly body: AnswerRequest;
  readonly key: string;
}

function replay(events: readonly AnswerEvent[], reply: FastifyReply): void {
  const send = openStream(reply);
  events.forEach(send);
  reply.raw.end();
}

/** Prompt and spend checks; a refusal frees the reserved Idempotency-Key for a retry. */
async function prepareOrRelease(
  service: AnswersService,
  call: AnswerCall,
): Promise<PreparedAnswer> {
  try {
    const prepared = await service.prepare(call.topic, call.body);
    await service.guardSpend(prepared.estimateUsd);
    return prepared;
  } catch (err) {
    service.release(call.key);
    throw err;
  }
}

/** Aborts the model when the client goes away (the body was read, so only the response tells). */
function abortOnDisconnect(reply: FastifyReply): AbortSignal {
  const abort = new AbortController();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  return abort.signal;
}

async function streamAnswer(
  service: AnswersService,
  call: AnswerCall,
  context: { request: FastifyRequest; reply: FastifyReply },
): Promise<void> {
  const { request, reply } = context;
  const cached = service.claim(call.key, call.topic, call.body);
  if (cached) return replay(cached, reply);
  // Watch the client from the start: leaving while passages are chosen must not reach the model.
  const signal = abortOnDisconnect(reply);
  const prepared = await prepareOrRelease(service, call);
  if (signal.aborted) {
    service.release(call.key);
    return;
  }
  const send = openStream(reply);
  try {
    for await (const event of service.stream(prepared, {
      signal,
      key: call.key,
    }))
      send(event);
  } catch (err) {
    request.log.error({ err }, 'answer stream failed');
    send({
      type: 'error',
      code: err instanceof AppError ? err.code : 'INTERNAL',
    });
  }
  reply.raw.end();
}

const answerOptions = {
  config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
  schema: {
    params: topicParams,
    body: answerRequestSchema,
    headers: answerHeaders,
  },
};

export const answerRoutes =
  ({ service, spendToday }: AnswerRouteOptions): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.post(
      '/api/v1/topics/:topic/answers/estimates',
      { ...estimateOptions, schema: estimateSchema },
      async (request) => service.estimate(request.params.topic, request.body),
    );
    typed.get('/api/v1/spend/today', { schema: spendSchema }, async () =>
      spendToday(),
    );
    typed.post(
      '/api/v1/topics/:topic/answers',
      answerOptions,
      async (request, reply) => {
        const call = {
          topic: request.params.topic,
          body: request.body,
          key: request.headers['idempotency-key'],
        };
        return streamAnswer(service, call, { request, reply });
      },
    );
  };
