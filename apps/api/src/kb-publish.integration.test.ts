import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  kbResult,
  leaseAs,
  leaseKb,
  mediaDb,
  publishedTracks,
  publisherMac,
} from '../test/kb-publish-harness.js';
import { worker } from '../test/media-harness.js';
import { asTranscriber } from '../test/transcription-harness.js';
import { startWorld } from '../test/track-items-harness.js';

afterEach(closeApp);

const rowsOf = (world: Awaited<ReturnType<typeof startWorld>>, sql: string) => {
  const db = mediaDb(world.media);
  try {
    return db.prepare(sql).all();
  } finally {
    db.close();
  }
};

describe('kb-publish: track documents through the Mac (KBC-099)', () => {
  it('FR-1: a publication wants one document per track and queues one job for the collection', async () => {
    const world = await startWorld();
    const { tracks } = await publishedTracks(world);
    expect(tracks).toHaveLength(2);
    const documents = rowsOf(
      world,
      'SELECT media_id, topic, path, state, published_sha256 FROM media_documents ORDER BY path',
    );
    expect(documents).toHaveLength(2);
    expect(documents.map((one) => one['topic'])).toEqual([
      'hermetismo',
      'hermetismo',
    ]);
    expect(documents.every((one) => one['published_sha256'] === null)).toBe(
      true,
    );
    const jobs = rowsOf(world, `SELECT topic, status FROM kb_publish_jobs`);
    expect(jobs).toEqual([{ topic: 'hermetismo', status: 'queued' }]);
  });

  it('AC-2: a transcriber without "Publica no acervo" never gets kb-publish', async () => {
    const world = await startWorld();
    await publishedTracks(world);
    // Asked with what it may do: nothing is there for it.
    const plain = await leaseAs(world.media, world.token, ['transcribe']);
    expect(plain.statusCode).toBe(204);
    // Asked for kb-publish itself: refused, the token may not lease it.
    const asked = await leaseAs(world.media, world.token, ['kb-publish']);
    expect(asked.statusCode).toBe(403);
    // The VM worker neither.
    const vm = await worker(world.media, '/api/v1/media-worker/jobs/lease', {
      worker: 'vm',
      kinds: ['kb-publish'],
    });
    expect(vm.statusCode).toBe(403);
  });

  it('AC-2: the marked Mac gets the documents, and its result publishes the fingerprints it was given', async () => {
    const world = await startWorld();
    const { recording, tracks } = await publishedTracks(world);
    const mac = await publisherMac(world.media);
    const job = await leaseKb(world.media, mac.token);
    expect(job.topic).toBe('hermetismo');
    expect(job.budgetUsd).toBeGreaterThan(0);
    expect(job.budgetUsd).toBeLessThanOrEqual(0.5);
    expect(job.items.map((item) => item.path).sort()).toEqual(
      tracks.map((track) => `raw/media/${recording.id}/${track.id}.md`).sort(),
    );
    const first = job.items.find((item) =>
      item.path.endsWith(`${tracks[0]?.id}.md`),
    );
    expect(first?.markdown).toContain(`kb_chat_media_id: ${tracks[0]?.id}`);
    expect(first?.markdown).toContain('# O que é o ritmo?');
    expect(first?.markdown).toContain(
      '[0:41] O ritmo é a lei do pêndulo que tudo governa',
    );

    const done = await kbResult(world.media, { token: mac.token, job });
    expect(done.statusCode, done.body).toBe(204);
    const documents = rowsOf(
      world,
      'SELECT path, state, desired_sha256, published_sha256 FROM media_documents',
    );
    for (const document of documents) {
      expect(document['state']).toBe('published');
      expect(document['published_sha256']).toBe(document['desired_sha256']);
    }
    expect(job.items.map((item) => item.fingerprint).sort()).toEqual(
      documents.map((one) => one['published_sha256']).sort(),
    );
    // Nothing left: the next lease finds no work.
    expect((await leaseAs(world.media, mac.token)).statusCode).toBe(204);
    // kb's spend is on the media ledger, per document (ADR 0035 §11).
    const spend = rowsOf(
      world,
      `SELECT kind, status, spent_usd FROM media_spend WHERE kind = 'kb-publish'`,
    );
    expect(spend).toHaveLength(2);
    expect(spend.every((row) => row['status'] === 'settled')).toBe(true);
  });

  it('FR-1: jobs coalesce: publishing again while one waits keeps one queued job', async () => {
    const world = await startWorld();
    await publishedTracks(world);
    await publishedTracks(world);
    const queued = rowsOf(
      world,
      `SELECT topic FROM kb_publish_jobs WHERE status = 'queued'`,
    );
    expect(queued).toEqual([{ topic: 'hermetismo' }]);
  });

  it("AC-4: a failed kb step fails the job with kb's output; it comes back, counted, then dead at 4", async () => {
    const world = await startWorld();
    await publishedTracks(world);
    const mac = await publisherMac(world.media);
    const output = 'kb classify: OpenRouter 502, nothing classified';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const job = await leaseKb(world.media, mac.token);
      expect(job.attempt).toBe(attempt);
      const failed = await asTranscriber(world.media, mac.token, {
        method: 'POST',
        url: `/api/v1/media-worker/jobs/${job.id}/fail`,
        payload: {
          worker: 'mac',
          leaseId: job.leaseId,
          failure: 'conversion-failed',
          detail: output,
        },
      });
      expect(failed.statusCode, failed.body).toBe(204);
    }
    const [job] = rowsOf(
      world,
      'SELECT status, error, attempts FROM kb_publish_jobs',
    );
    expect(job).toEqual({ status: 'dead', error: output, attempts: 4 });
    const documents = rowsOf(
      world,
      'SELECT last_error, published_sha256 FROM media_documents',
    );
    expect(documents.every((one) => one['last_error'] === output)).toBe(true);
    expect(documents.every((one) => one['published_sha256'] === null)).toBe(
      true,
    );
    expect((await leaseAs(world.media, mac.token)).statusCode).toBe(204);
  });

  it('a document kb could not take stays to publish; the job still ends', async () => {
    const world = await startWorld();
    await publishedTracks(world);
    const mac = await publisherMac(world.media);
    const job = await leaseKb(world.media, mac.token);
    const done = await kbResult(
      world.media,
      { token: mac.token, job },
      { ok: false },
    );
    expect(done.statusCode, done.body).toBe(204);
    const documents = rowsOf(
      world,
      'SELECT state, last_error FROM media_documents',
    );
    expect(documents.every((one) => one['state'] === 'failed')).toBe(true);
    expect(
      documents.every((one) => one['last_error'] === 'kb link: exit 1'),
    ).toBe(true);
    // The same documents are offered again to the next job.
    const again = await leaseKb(world.media, mac.token);
    expect(again.items).toHaveLength(2);
  });

  it('a result or heartbeat on a lease that is not held is refused (409), another token sees nothing (404)', async () => {
    const world = await startWorld();
    await publishedTracks(world);
    const mac = await publisherMac(world.media);
    const job = await leaseKb(world.media, mac.token);
    const stale = await kbResult(
      world.media,
      { token: mac.token, job },
      {
        leaseId: '00000000-0000-4000-8000-000000000000',
      },
    );
    expect(stale.statusCode).toBe(409);
    const beat = await asTranscriber(world.media, mac.token, {
      method: 'POST',
      url: `/api/v1/media-worker/jobs/${job.id}/heartbeat`,
      payload: { worker: 'mac', leaseId: job.leaseId, progress: 50 },
    });
    expect(beat.statusCode).toBe(204);
    const other = await kbResult(world.media, { token: world.token, job });
    expect(other.statusCode).toBe(404);
  });

  it('a transcriber holding a kb-publish job takes no other job meanwhile (one at a time)', async () => {
    const world = await startWorld();
    await publishedTracks(world);
    const mac = await publisherMac(world.media, ['transcribe', 'kb-publish']);
    await leaseKb(world.media, mac.token);
    const second = await leaseAs(world.media, mac.token, [
      'transcribe',
      'kb-publish',
    ]);
    expect(second.statusCode).toBe(204);
  });
});
