import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import { mediaIdSchema, rawSpeakerTurnSchema } from '@kb-chat/contracts';
import { z } from 'zod';
import { openMediaDatabase } from '../adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../adapters/sqlite/media-migrations.js';
import type { MediaDeps } from '../media-factory.js';
import type { LeaseOwner } from '../ports/media-store.js';
import { PUBLIC } from '../modules/auth/index.js';
import { DiarizationService } from '../modules/media/index.js';

const params = z.object({ id: mediaIdSchema });
const body = z.object({ turns: z.array(rawSpeakerTurnSchema) });
const WORKER = 'e2e-diarizer';
const LEASE_MS = 10 * 60 * 1000;

/** Leases the media's queued diarize job to the E2E "transcriber"; null when none. */
function leaseQueued(db: DatabaseSync, mediaId: string): Held | null {
  const job = db
    .prepare(
      `SELECT id, voices FROM jobs WHERE media_id = ? AND kind = 'diarize'
         AND status = 'queued' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(mediaId);
  if (!job) return null;
  const owner = {
    jobId: String(job['id']),
    leaseId: randomUUID(),
    worker: WORKER,
    voices: job['voices'] === null ? null : Number(job['voices']),
  };
  db.prepare(
    `UPDATE jobs SET status = 'leased', lease_id = ?, worker = ?, lease_until = ?,
       attempts = attempts + 1 WHERE id = ?`,
  ).run(owner.leaseId, WORKER, Date.now() + LEASE_MS, owner.jobId);
  return owner;
}

/**
 * The E2E server only (KBC-064): leases one media's queued voice separation (POST …/lease,
 * so a spec can see "Separando vozes…") and completes it with fixture turns through the
 * real path (raw file, derivation, voices per segment and word). The specs never lease
 * through the worker routes, so no transcriber turns "on" under another spec.
 */
export function registerDiarizationSeed(
  app: FastifyInstance,
  input: { media: MediaDeps; mediaDir: string },
): void {
  const db = openMediaDatabase(
    join(input.mediaDir, 'media.db'),
    MEDIA_MIGRATIONS,
  );
  app.addHook('onClose', async () => db.close());
  const held = new Map<string, Held>();
  app.post(
    '/api/e2e/media/:id/diarization/lease',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { id } = params.parse(request.params);
      const owner = leaseQueued(db, id);
      if (!owner) return reply.code(409).send({ error: 'no queued job' });
      held.set(id, owner);
      return reply.code(204).send();
    },
  );
  registerCompletion(app, {
    diarization: new DiarizationService(input.media),
    take: (id) => {
      const owner = held.get(id) ?? leaseQueued(db, id);
      held.delete(id);
      return owner;
    },
  });
}

type Held = LeaseOwner & { voices: number | null };

/** Completes the media's separation (leased before, or leased now) with `turns`. */
function registerCompletion(
  app: FastifyInstance,
  input: { diarization: DiarizationService; take: (id: string) => Held | null },
): void {
  app.post(
    '/api/e2e/media/:id/diarization',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { id } = params.parse(request.params);
      const { turns } = body.parse(request.body);
      const owner = input.take(id);
      if (!owner) return reply.code(409).send({ error: 'no queued job' });
      await input.diarization.complete(owner, {
        worker: owner.worker,
        leaseId: owner.leaseId,
        engine: 'senko',
        model: 'e2e',
        parametersVersion: 'e2e',
        parameters: {},
        requestedVoices: owner.voices,
        elapsedMs: 0,
        raw: { turns },
      });
      return reply.code(204).send();
    },
  );
}
