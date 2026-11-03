import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import {
  mediaIdSchema,
  rawTranscriptSchema,
  type RawTranscript,
} from '@kb-chat/contracts';
import { z } from 'zod';
import { openMediaDatabase } from '../adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../adapters/sqlite/media-migrations.js';
import type { MediaDeps } from '../media-factory.js';
import type { LeaseOwner } from '../ports/media-store.js';
import { PUBLIC } from '../modules/auth/index.js';
import { TranscriptionService } from '../modules/media/index.js';

const params = z.object({ id: mediaIdSchema });
const body = z.object({ raw: rawTranscriptSchema });
const WORKER = 'e2e-transcriber';
const LEASE_MS = 10 * 60 * 1000;

/** Leases the media's queued transcribe job to the E2E "transcriber"; null when none. */
function leaseQueued(db: DatabaseSync, mediaId: string): LeaseOwner | null {
  const job = db
    .prepare(
      `SELECT id FROM jobs WHERE media_id = ? AND kind = 'transcribe'
         AND status = 'queued' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(mediaId);
  if (!job) return null;
  const owner = {
    jobId: String(job['id']),
    leaseId: randomUUID(),
    worker: WORKER,
  };
  db.prepare(
    `UPDATE jobs SET status = 'leased', lease_id = ?, worker = ?, lease_until = ?,
       attempts = attempts + 1 WHERE id = ?`,
  ).run(owner.leaseId, WORKER, Date.now() + LEASE_MS, owner.jobId);
  return owner;
}

/** What a transcriber would send with this raw result. */
const resultOf = (
  owner: LeaseOwner,
  input: { raw: RawTranscript; termsVersion: number },
) => ({
  worker: owner.worker,
  leaseId: owner.leaseId,
  provider: 'mlx-whisper' as const,
  model: 'e2e',
  parametersVersion: 'e2e',
  parameters: {},
  termsVersion: input.termsVersion,
  vad: 'applied' as const,
  speechRatio: 1,
  elapsedMs: 0,
  raw: input.raw,
});

/**
 * The E2E server only (KBC-038): stores a transcript for one media through the real
 * transcription path (bounds check, raw file, post-filter, confidence, new version), as if
 * a transcriber had leased that media's queued job. The specs never lease through the
 * worker routes, so no transcriber turns "on" under another spec (KBC-036 AC-2).
 */
export function registerTranscriptSeed(
  app: FastifyInstance,
  input: { media: MediaDeps; mediaDir: string },
): void {
  // A second connection to the same WAL database, for the one UPDATE no port offers.
  const db = openMediaDatabase(
    join(input.mediaDir, 'media.db'),
    MEDIA_MIGRATIONS,
  );
  app.addHook('onClose', async () => db.close());
  const transcription = new TranscriptionService(input.media);
  app.post(
    '/api/e2e/media/:id/transcript',
    { config: { access: PUBLIC }, bodyLimit: 32 * 1024 * 1024 },
    async (request, reply) => {
      const { id } = params.parse(request.params);
      const { raw } = body.parse(request.body);
      const owner = leaseQueued(db, id);
      if (!owner) return reply.code(409).send({ error: 'no queued job' });
      const termsVersion = transcription.terms().version;
      await transcription.complete(
        owner,
        resultOf(owner, { raw, termsVersion }),
      );
      return reply.code(204).send();
    },
  );
}
