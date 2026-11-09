/**
 * KBC-113 NFR-1 and NFR-2: the rules on a 2 h version (about 20 000 words) with 1 000 rules,
 * and the masters' reading with 10 000 corrections in 500 recordings, on the real database.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TranscriptLearning } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import { startWorld, transcribed } from '../test/track-items-harness.js';
import {
  applyRules,
  deriveRules,
  type LearningSource,
} from './modules/media-corrections/learning-rules.js';
import type { PlacedWord } from './modules/media-corrections/word-rewrite.js';

afterEach(closeApp);

/** As KBC-093's latency test: strict on a quiet machine, ten times over inside the gates. */
const STRICT = process.env['KBC_LATENCY_STRICT'] === '1';
const LOADED_FACTOR = 10;
const budget = STRICT ? 1 : LOADED_FACTOR;

const p95 = (samples: readonly number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return (
    sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
  );
};

const AT = '2026-11-09T10:00:00.000Z';

describe('Learning latency (KBC-113 NFR-1, NFR-2)', () => {
  it('NFR-1: 1 000 rules on 20 000 words in p95 ≤ 300 ms', () => {
    const sources: LearningSource[] = Array.from({ length: 1_000 }, (_, n) => ({
      id: `c${n}`,
      mediaId: `m${n % 500}`,
      mediaTitle: 'Palestra',
      startMs: 0,
      before: [`erro${n}`],
      after: `Certo${n}`,
      contextBefore: `antes${n % 7}`,
      contextAfter: `depois${n % 11}`,
      createdAt: AT,
      authorName: null,
    }));
    const words: PlacedWord[] = Array.from({ length: 20_000 }, (_, n) => ({
      position: n,
      segment: Math.floor(n / 10),
      startMs: n * 360,
      endMs: (n + 1) * 360,
      text: n % 3 === 0 ? `erro${n % 1_000}` : `antes${n % 7}`,
    }));
    const samples: number[] = [];
    let changed = 0;
    for (let round = 0; round < 10; round++) {
      const started = performance.now();
      changed = applyRules(words, deriveRules(sources), new Set()).length;
      samples.push(performance.now() - started);
    }
    expect(changed).toBeGreaterThan(0);
    expect(p95(samples)).toBeLessThanOrEqual(300 * budget);
  });

  it('NFR-2: the masters reading answers in p95 ≤ 400 ms with 10 000 corrections in 500 recordings', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const recording = await transcribed(world, [
      { at: 10, text: 'um dois três quatro cinco seis sete oito nove dez' },
    ]);
    const db = new DatabaseSync(join(world.media.mediaDir, 'media.db'));
    try {
      const transcript = db
        .prepare('SELECT id FROM transcripts WHERE media_id = ?')
        .get(recording.id);
      const columns = db
        .prepare('SELECT name FROM pragma_table_info(?)')
        .all('media')
        .map((row) => String(row['name']))
        .filter((name) => name !== 'id');
      const copy = db.prepare(
        `INSERT INTO media (id, ${columns.join(', ')})
         SELECT ?, ${columns.join(', ')} FROM media WHERE id = ?`,
      );
      const ids = [recording.id];
      for (let n = 1; n < 500; n++) {
        const id = randomUUID();
        copy.run(id, recording.id);
        ids.push(id);
      }
      const insert = db.prepare(
        `INSERT INTO transcript_corrections (id, media_id, transcript_id, version, revision,
           kind, first_position, word_count, segment_position, start_ms, end_ms, before, after,
           state, author_principal, author_name, created_at)
         VALUES (?, ?, ?, 1, 1, 'correct', ?, 1, 0, 0, 400, ?, ?, 'active', 'owner', 'Dono', ?)`,
      );
      db.exec('BEGIN');
      for (let n = 0; n < 10_000; n++)
        insert.run(
          randomUUID(),
          ids[n % 500] ?? recording.id,
          // A transcript of its own per row: each correction is another span (no FK).
          n < 10 ? String(transcript?.['id']) : `t${n}`,
          n % 10,
          JSON.stringify([`erro${n % 2_000}`]),
          `Certo${n % 2_000}`,
          AT,
        );
      db.exec('COMMIT');
    } finally {
      db.close();
    }

    const samples: number[] = [];
    let body: TranscriptLearning | null = null;
    for (let round = 0; round < 10; round++) {
      const started = performance.now();
      const read = await owner('GET', '/api/v1/media/learning');
      samples.push(performance.now() - started);
      expect(read.statusCode).toBe(200);
      body = read.json<TranscriptLearning>();
    }
    expect(body?.rules.length).toBeGreaterThanOrEqual(2_000);
    expect(p95(samples)).toBeLessThanOrEqual(400 * budget);
  }, 120_000);
});
