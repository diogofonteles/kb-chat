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
import type { AnswersService } from './answers-service.js';

export interface AnswerRouteOptions {
  readonly service: AnswersService;
  readonly spendToday: () => Promise<{
    usd: number;
    capUsd: number;
    configured: boolean;
  }>;
}

const topicParams = z.object({ topic: topicSlugSchema });
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

function replayCached(
  service: AnswersService,
  key: string,
  reply: FastifyReply,
): boolean {
  const cached = service.replay(key);
  if (!cached) return false;
  const send = openStream(reply);
  cached.forEach(send);
  reply.raw.end();
  return true;
}

async function streamAnswer(
  service: AnswersService,
  call: AnswerCall,
  context: { request: FastifyRequest; reply: FastifyReply },
): Promise<void> {
  const { request, reply } = context;
  if (replayCached(service, call.key, reply)) return;
  // Every refusal (no provider, cap, credit) happens here, before any spend and before streaming.
  const prepared = await service.prepare(call.topic, call.body);
  await service.guardSpend(prepared.estimateUsd);
  const abort = new AbortController();
  request.raw.on('close', () => abort.abort());
  const send = openStream(reply);
  try {
    for await (const event of service.stream(prepared, {
      signal: abort.signal,
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

export const answerRoutes =
  ({ service, spendToday }: AnswerRouteOptions): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.post(
      '/api/v1/topics/:topic/answers/estimates',
      { schema: estimateSchema },
      async (request) => service.estimate(request.params.topic, request.body),
    );
    typed.get('/api/v1/spend/today', { schema: spendSchema }, async () =>
      spendToday(),
    );
    typed.post(
      '/api/v1/topics/:topic/answers',
      {
        schema: {
          params: topicParams,
          body: answerRequestSchema,
          headers: answerHeaders,
        },
      },
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
