import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { mediaIdSchema } from '@kb-chat/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { openMediaDatabase } from '../adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../adapters/sqlite/media-migrations.js';
import { PUBLIC } from '../modules/auth/index.js';

const params = z.object({ id: mediaIdSchema });
const body = z.object({
  tracks: z.array(
    z.object({
      title: z.string(),
      startMs: z.number(),
      endMs: z.number(),
      answererVoice: z.number(),
    }),
  ),
  voices: z.array(z.object({ voice: z.number(), name: z.string() })),
});

type Seed = z.infer<typeof body>;

function storeRun(db: DatabaseSync, mediaId: string): string {
  const at = new Date().toISOString();
  const runId = randomUUID();
  const transcript = db
    .prepare(
      'SELECT id FROM transcripts WHERE media_id = ? ORDER BY version DESC LIMIT 1',
    )
    .get(mediaId);
  db.prepare(
    `INSERT INTO media_proposal_runs (id, media_id, transcript_id, principal, model,
       spend_id, status, windows_total, windows_done, estimate_usd, created_at, finished_at)
     VALUES (?, ?, ?, 'e2e', 'stub', ?, 'done', 1, 1, 0, ?, ?)`,
  ).run(runId, mediaId, String(transcript?.['id']), randomUUID(), at, at);
  db.prepare(
    `INSERT OR IGNORE INTO media_edits (media_id, version, status, step, updated_by,
       updated_at) VALUES (?, 1, 'draft', 3, 'e2e', ?)`,
  ).run(mediaId, at);
  return runId;
}

function storeProposal(
  db: DatabaseSync,
  run: { readonly mediaId: string; readonly runId: string },
  { tracks, voices }: Seed,
): void {
  const { mediaId, runId } = run;
  for (const { voice, name } of voices)
    db.prepare(
      `INSERT INTO media_voice_suggestions (run_id, voice, name, audience, reason)
       VALUES (?, ?, ?, 0, 'se apresenta')`,
    ).run(runId, voice, name);
  for (const track of tracks)
    db.prepare(
      `INSERT INTO media_draft_tracks (id, media_id, run_id, source, start_ms, end_ms,
         kind, title, answerer_voice, created_at)
       VALUES (?, ?, ?, 'ai', ?, ?, 'qa', ?, ?, ?)`,
    ).run(
      randomUUID(),
      mediaId,
      runId,
      track.startMs,
      track.endMs,
      track.title,
      track.answererVoice,
      new Date().toISOString(),
    );
}

/**
 * The E2E server only (KBC-090): a finished proposal stored as a run would leave it, since the
 * server's fake model cannot be scripted from a spec and its names must be in the speech.
 */
export function registerProposalSeed(
  app: FastifyInstance,
  input: { mediaDir: string },
): void {
  const db = openMediaDatabase(
    join(input.mediaDir, 'media.db'),
    MEDIA_MIGRATIONS,
  );
  app.addHook('onClose', async () => db.close());
  app.post(
    '/api/e2e/media/:id/proposal',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { id: mediaId } = params.parse(request.params);
      const runId = storeRun(db, mediaId);
      storeProposal(db, { mediaId, runId }, body.parse(request.body));
      return reply.code(204).send();
    },
  );
}
