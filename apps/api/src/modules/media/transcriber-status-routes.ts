import {
  type LocalTranscriberStart,
  localTranscriberStartSchema,
  transcriberStatusOverviewSchema,
  transcriberStatusReportSchema,
} from '@kb-chat/contracts';
import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { AppError } from '../../app-error.js';
import type { LocalTranscriberPort } from '../../ports/local-transcriber.js';
import { TRANSCRIBER_LEASE_PREFIX } from '../../ports/transcriber-store.js';
import { PUBLIC, type RouteAccess } from '../auth/index.js';
import type { TranscriberStatusBoard } from './transcriber-status.js';

/** Masters only, as the rest of Transcritores (KBC-036 BR-1). */
const MASTER: RouteAccess = { master: true };

/** A status body is small: what it says fits in a few KB (NFR-1). */
const STATUS_BODY_BYTES = 16 * 1024;

export interface TranscriberStatusRouteDeps {
  readonly board: TranscriberStatusBoard;
  /** A start the API made is still under way (no word from the transcriber since). */
  readonly startingNow?: () => boolean;
  /** Only when this API runs on the transcriber's Mac (KB_CHAT_LOCAL_TRANSCRIBER=1). */
  readonly local: LocalTranscriberPort | null;
}

/** What masters read of the transcribers' status, and "Ligar transcritor" (KBC-114). */
export const transcriberStatusRoutes =
  (deps: TranscriberStatusRouteDeps): FastifyPluginAsync =>
  async (app) => {
    const typed = app.withTypeProvider<ZodTypeProvider>();
    typed.get(
      '/api/v1/media/transcribers/status',
      {
        config: { access: MASTER },
        schema: { response: { 200: transcriberStatusOverviewSchema } },
      },
      async () => deps.board.overview(),
    );
    if (deps.local)
      registerLocalStart(
        app,
        new LocalStarter(deps.local, {
          anyOnline: () => deps.board.anyOnline(),
          startingNow: deps.startingNow ?? (() => false),
          saidSince: (at) => deps.board.saidSince(at),
        }),
      );
  };

/** How long a start may take before a word from the transcriber (uv, extras, models). */
export const STARTING_GRACE_MS = 10 * 60 * 1000;

/** Two presses this close start it once (QA F-2: a second `-k` would kill the first). */
export const LOCAL_START_COOLDOWN_MS = 30_000;

/**
 * "Ligar transcritor" (QA F-2): a restart (`kickstart -k`) only when no transcriber is on;
 * with one on, a plain `kickstart`, which never kills the job in hand; and once per
 * LOCAL_START_COOLDOWN_MS.
 */
export class LocalStarter {
  private lastAt = Number.NEGATIVE_INFINITY;
  /** Its own last start (review r3 S-5): while that one still prepares, never `-k`. */
  private startedAt: Date | null = null;

  constructor(
    private readonly local: LocalTranscriberPort,
    private readonly board: {
      anyOnline(): boolean;
      /** A start the API made is still under way (uv installing, models loading). */
      startingNow(): boolean;
      /** Whether the transcriber said anything at or after this moment. */
      saidSince(at: Date): boolean;
    },
    private readonly now: () => Date = () => new Date(),
  ) {}

  async start(): Promise<LocalTranscriberStart> {
    const at = this.now().getTime();
    if (at - this.lastAt < LOCAL_START_COOLDOWN_MS)
      return { ok: true, detail: 'already asked a moment ago' };
    this.lastAt = at;
    // `-k` would kill the job in hand, or a start still installing its extras: the API's
    // (r2 S-1) or a press of its own a moment ago (r3 S-5).
    const busy =
      this.board.anyOnline() ||
      this.board.startingNow() ||
      this.ownStartPreparing(at);
    this.startedAt = this.now();
    return busy ? this.local.wake() : this.local.start();
  }

  private ownStartPreparing(at: number): boolean {
    const started = this.startedAt;
    return (
      started !== null &&
      at - started.getTime() < STARTING_GRACE_MS &&
      !this.board.saidSince(started)
    );
  }
}

/** BR-10: a fixed program with fixed arguments; the route exists only on the Mac. */
function registerLocalStart(app: FastifyInstance, local: LocalStarter): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media/transcribers/local/start',
    {
      config: { access: MASTER },
      schema: { response: { 200: localTranscriberStartSchema } },
    },
    async (request) => {
      const started = await local.start();
      if (!started.ok)
        request.log.warn(
          { detail: started.detail },
          'transcriber: launchctl kickstart failed',
        );
      return started;
    },
  );
}

/**
 * POST /api/v1/media-worker/status (FR-8): a paired transcriber's own status, by its token.
 * Registered inside the workers' scope, whose hook names the token (401 without one); the
 * VM's token has no transcriber to speak for (403).
 */
export function registerWorkerStatus(
  app: FastifyInstance,
  board: TranscriberStatusBoard,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  typed.post(
    '/api/v1/media-worker/status',
    {
      config: { access: PUBLIC },
      bodyLimit: STATUS_BODY_BYTES,
      schema: {
        body: transcriberStatusReportSchema,
        response: { 204: z.undefined() },
      },
    },
    async (request, reply) => {
      const leaseName = request.workerIdentity?.leaseName ?? null;
      if (!leaseName?.startsWith(TRANSCRIBER_LEASE_PREFIX))
        throw new AppError(
          'FORBIDDEN',
          'Only a paired transcriber has a status',
        );
      board.record(
        leaseName.slice(TRANSCRIBER_LEASE_PREFIX.length),
        request.body,
      );
      return reply.code(204).send();
    },
  );
}
