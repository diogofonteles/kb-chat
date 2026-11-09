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
import { LearningService } from '../modules/media-corrections/index.js';
import {
  TranscriptionService,
  countPromptTokens,
} from '../modules/media/index.js';

const params = z.object({ id: mediaIdSchema });
/**
 * `learn`: the new version gets the learned rules, as the app's own path does (KBC-113 FR-1).
 * Off by default: the E2E database is shared, and other specs' corrections must not change
 * the text a spec seeds.
 */
const body = z.object({
  raw: rawTranscriptSchema,
  learn: z.boolean().default(false),
});
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
 * The transcription path of the seed; the media in `learnFor` get the learned rules on their
 * new version (KBC-113 FR-1). Seeds of other specs run alongside: only those that ask.
 */
function seedTranscription(media: MediaDeps) {
  const learning = new LearningService({
    corrections: media.corrections,
    transcripts: media.transcripts,
    countTokens: countPromptTokens,
  });
  const learnFor = new Set<string>();
  const transcription = new TranscriptionService({
    ...media,
    onTranscript: (mediaId) => {
      if (learnFor.has(mediaId)) learning.apply(mediaId);
    },
  });
  return { transcription, learnFor };
}

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
  const { transcription, learnFor } = seedTranscription(input.media);
  app.post(
    '/api/e2e/media/:id/transcript',
    { config: { access: PUBLIC }, bodyLimit: 32 * 1024 * 1024 },
    async (request, reply) => {
      const { id } = params.parse(request.params);
      const parsed = body.parse(request.body);
      const owner = leaseQueued(db, id);
      if (!owner) return reply.code(409).send({ error: 'no queued job' });
      const termsVersion = transcription.terms().version;
      const result = resultOf(owner, { raw: parsed.raw, termsVersion });
      if (parsed.learn) learnFor.add(id);
      await transcription
        .complete(owner, result)
        .finally(() => learnFor.delete(id));
      return reply.code(204).send();
    },
  );
}
