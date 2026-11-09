/**
 * KBC-093 NFR-1 and NFR-6: corrections on a 2 h recording (about 20 000 words) with 12
 * published tracks, measured through the real routes on the real media database.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Occurrences, RawTranscript } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { correctionsUrl, transcriptUrl } from '../test/correction-harness.js';
import {
  CONVERTED,
  leaseJob,
  queuedItem,
  worker,
} from '../test/media-harness.js';
import {
  approve,
  finishCuts,
  startWorld,
  type World,
} from '../test/track-items-harness.js';
import {
  FLAC,
  leaseTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';

afterEach(closeApp);

const TWO_HOURS_MS = 7_200_000;
const WORDS = 20_000;
const PER_SEGMENT = 10;
/** One "Tiuako" every 100 words: 200 in the recording. */
const EVERY = 100;
const WORD_S = TWO_HOURS_MS / 1000 / WORDS;

const wordAt = (index: number) =>
  index % EVERY === 0 ? 'Tiuako' : `palavra${index}`;

function longRaw(): RawTranscript {
  const segments = Array.from({ length: WORDS / PER_SEGMENT }, (_, s) => {
    const indexes = Array.from(
      { length: PER_SEGMENT },
      (_, w) => s * PER_SEGMENT + w,
    );
    const words = indexes.map((index) => ({
      word: ` ${wordAt(index)}`,
      start: index * WORD_S,
      end: (index + 1) * WORD_S,
      probability: 0.95,
    }));
    return {
      start: indexes[0] ? indexes[0] * WORD_S : 0,
      end: ((indexes.at(-1) ?? 0) + 1) * WORD_S,
      text: words.map((word) => word.word).join(''),
      avg_logprob: -0.2,
      compression_ratio: 1.3,
      no_speech_prob: 0.01,
      words,
    };
  });
  return {
    chunks: [{ offset: 0, end: TWO_HOURS_MS / 1000, result: { segments } }],
  };
}

async function twoHours(world: World): Promise<string> {
  const { media, token } = world;
  const item = await queuedItem(media, 'hermetismo');
  const job = await leaseJob(media);
  writeFileSync(join(media.mediaDir, job.targetPath), CONVERTED);
  if (job.flacTargetPath)
    writeFileSync(join(media.mediaDir, job.flacTargetPath), FLAC);
  const converted = await worker(
    media,
    `/api/v1/media-worker/jobs/${job.id}/complete`,
    {
      worker: 'vm',
      leaseId: job.leaseId,
      durationMs: TWO_HOURS_MS,
      bytes: CONVERTED.length,
      flacBytes: FLAC.length,
    },
  );
  expect(converted.statusCode, converted.body).toBe(204);
  const lease = await leaseTranscription(media, token);
  const sent = await sendTranscript(media, {
    token,
    job: lease,
    raw: longRaw(),
  });
  expect(sent.statusCode, sent.body).toBe(204);
  await approve(
    media,
    item.id,
    Array.from({ length: 12 }, (_, index) => ({
      startMs: index * 600_000,
      endMs: (index + 1) * 600_000,
      title: `Faixa ${index + 1}`,
    })),
  );
  expect(await finishCuts(media)).toBe(12);
  return item.id;
}

/**
 * The NFR budgets hold on a quiet machine (`KBC_LATENCY_STRICT=1`, as the evidence is taken);
 * inside `pnpm gates` every suite runs side by side, so only a regression ten times over fails.
 */
const STRICT = process.env['KBC_LATENCY_STRICT'] === '1';
const LOADED_FACTOR = 10;

const p95 = (samples: readonly number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return (
    sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
  );
};

async function timed<T>(
  work: () => Promise<T>,
): Promise<{ ms: number; value: T }> {
  const started = performance.now();
  const value = await work();
  return { ms: performance.now() - started, value };
}

describe('Corrections on a 2 h recording with 12 tracks (KBC-093 NFR-1, NFR-6)', () => {
  it('a word saves in p95 ≤ 150 ms; the preview answers in p95 ≤ 300 ms; 200 at once save in p95 ≤ 2 s', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const id = await twoHours(world);

    const single: number[] = [];
    for (let round = 0; round < 20; round++) {
      const position = 1 + round * 997;
      const { ms, value } = await timed(() =>
        owner('POST', correctionsUrl(id), {
          version: 1,
          position,
          count: 1,
          expected: [wordAt(position)],
          text: `certa${round}`,
        }),
      );
      expect(value.statusCode, value.body).toBe(201);
      single.push(ms);
    }

    const previews: number[] = [];
    let preview: Occurrences | null = null;
    for (let round = 0; round < 10; round++) {
      const { ms, value } = await timed(() =>
        owner('GET', `${transcriptUrl(id)}/occurrences?text=tiuako`),
      );
      previews.push(ms);
      preview = value.json<Occurrences>();
    }
    expect(preview?.total).toBe(WORDS / EVERY);

    const batches: number[] = [];
    for (const [round, [from, to]] of [
      ['Tiuako', 'Tiuaco'],
      ['Tiuaco', 'Tiuako'],
      ['Tiuako', 'Tiuaco'],
    ].entries()) {
      const items = Array.from({ length: WORDS / EVERY }, (_, index) => ({
        position: index * EVERY,
        count: 1,
        expected: [from],
      }));
      const { ms, value } = await timed(() =>
        owner('POST', `${correctionsUrl(id)}/batch`, {
          version: 1,
          key: randomUUID(),
          text: to,
          items,
        }),
      );
      expect(value.statusCode, `${round}: ${value.body.slice(0, 200)}`).toBe(
        201,
      );
      batches.push(ms);
    }

    const budget = STRICT ? 1 : LOADED_FACTOR;
    expect(p95(single)).toBeLessThanOrEqual(150 * budget);
    expect(p95(previews)).toBeLessThanOrEqual(300 * budget);
    expect(p95(batches)).toBeLessThanOrEqual(2_000 * budget);
  }, 120_000);
});
