/**
 * KBC-113 NFR-1 and NFR-2, on the real database and the real path (review round 1):
 * `LearningService.apply` inside a transaction (the log read, 1 000 rules from people's
 * corrections with their context words, 20 000 words, every replacement written), and the
 * masters' reading with 10 000 corrections on 500 recordings that have their words.
 */
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RawTranscript, TranscriptLearning } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  CONVERTED,
  leaseJob,
  queuedItem,
  worker,
} from '../test/media-harness.js';
import {
  startWorld,
  transcribed,
  type World,
} from '../test/track-items-harness.js';
import {
  FLAC,
  leaseTranscription,
  sendTranscript,
} from '../test/transcription-harness.js';
import { SqliteTranscriptCorrectionStore } from './adapters/sqlite/sqlite-transcript-correction-store.js';
import { SqliteTranscriptStore } from './adapters/sqlite/sqlite-transcript-store.js';
import { LearningService } from './modules/media-corrections/index.js';
import { countPromptTokens } from './modules/media/index.js';

afterEach(closeApp);

/** As KBC-093's latency test: strict on a quiet machine, ten times over inside the gates. */
const STRICT = process.env['KBC_LATENCY_STRICT'] === '1';
const budget = STRICT ? 1 : 10;

const p95 = (samples: readonly number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return (
    sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY
  );
};

const AT = '2026-11-09T10:00:00.000Z';
const TWO_HOURS_MS = 7_200_000;
const WORDS = 20_000;
const PER_SEGMENT = 10;
const WORD_S = TWO_HOURS_MS / 1000 / WORDS;
const RULES = 1_000;
/** A rule every 20 words, never at a segment's edge: both its neighbours are words. */
const ruleAt = (n: number) => n * 20 + 4;

function longRaw(): RawTranscript {
  const segments = Array.from({ length: WORDS / PER_SEGMENT }, (_, s) => {
    const words = Array.from({ length: PER_SEGMENT }, (_, w) => {
      const index = s * PER_SEGMENT + w;
      return {
        word: ` palavra${index}`,
        start: index * WORD_S,
        end: (index + 1) * WORD_S,
        probability: 0.95,
      };
    });
    return {
      start: words[0]?.start ?? 0,
      end: words.at(-1)?.end ?? 0,
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
  return item.id;
}

const openDb = (world: World) =>
  new DatabaseSync(join(world.media.mediaDir, 'media.db'));

const transcriptOf = (db: DatabaseSync, mediaId: string): string =>
  String(
    db.prepare('SELECT id FROM transcripts WHERE media_id = ?').get(mediaId)?.[
      'id'
    ],
  );

const INSERT = `INSERT INTO transcript_corrections (id, media_id, transcript_id, version,
    revision, kind, first_position, word_count, segment_position, start_ms, end_ms, before,
    after, state, author_principal, author_name, created_at)
  VALUES (?, ?, ?, 1, 1, 'correct', ?, 1, ?, 0, 400, ?, ?, 'active', 'owner', 'Dono', ?)`;

describe('Learning latency (KBC-113 NFR-1, NFR-2)', () => {
  it('NFR-1: 1 000 rules applied to a 20 000-word version in p95 ≤ 300 ms, inside the transaction', async () => {
    const world = await startWorld();
    const teacher = await twoHours(world);
    const target = await twoHours(world);
    const db = openDb(world);
    try {
      const insert = db.prepare(INSERT);
      const from = transcriptOf(db, teacher);
      db.exec('BEGIN');
      for (let n = 0; n < RULES; n++)
        insert.run(
          randomUUID(),
          teacher,
          from,
          ruleAt(n),
          Math.floor(ruleAt(n) / PER_SEGMENT),
          JSON.stringify([`palavra${ruleAt(n)}`]),
          `Certo${n}`,
          AT,
        );
      db.exec('COMMIT');
      let applied = 0;
      const learning = new LearningService({
        corrections: new SqliteTranscriptCorrectionStore(db),
        transcripts: new SqliteTranscriptStore(db),
        countTokens: countPromptTokens,
        onApplied: (event) => (applied = event.rules),
      });
      const samples: number[] = [];
      for (let round = 0; round < 10; round++) {
        db.exec('BEGIN IMMEDIATE');
        const started = performance.now();
        learning.apply(target);
        samples.push(performance.now() - started);
        db.exec('ROLLBACK');
      }
      expect(applied).toBe(RULES);
      expect(p95(samples)).toBeLessThanOrEqual(300 * budget);
    } finally {
      db.close();
    }
  }, 180_000);

  it('NFR-2: the masters reading answers in p95 ≤ 400 ms with 10 000 corrections on 500 recordings with their words', async () => {
    const world = await startWorld();
    const { owner } = world.media;
    const words = Array.from({ length: 40 }, (_, n) => `termo${n}`);
    const recording = await transcribed(world, [
      { at: 10, text: words.join(' ') },
    ]);
    const db = openDb(world);
    try {
      const columns = (table: string) =>
        db
          .prepare('SELECT name FROM pragma_table_info(?)')
          .all(table)
          .map((row) => String(row['name']))
          .filter((name) => name !== 'id' && name !== 'media_id');
      const media = columns('media');
      const transcripts = columns('transcripts');
      const source = transcriptOf(db, recording.id);
      const copyMedia = db.prepare(
        `INSERT INTO media (id, ${media.join(', ')})
         SELECT ?, ${media.join(', ')} FROM media WHERE id = ?`,
      );
      const copyTranscript = db.prepare(
        `INSERT INTO transcripts (id, media_id, ${transcripts.join(', ')})
         SELECT ?, ?, ${transcripts.join(', ')} FROM transcripts WHERE id = ?`,
      );
      const copyWords = db.prepare(
        `INSERT INTO words (transcript_id, position, segment_position, start_ms, end_ms, text,
           probability)
         SELECT ?, position, segment_position, start_ms, end_ms, text, probability
         FROM words WHERE transcript_id = ?`,
      );
      const insert = db.prepare(INSERT);
      db.exec('BEGIN');
      for (let m = 0; m < 500; m++) {
        const mediaId = m === 0 ? recording.id : randomUUID();
        const transcriptId = m === 0 ? source : randomUUID();
        if (m > 0) {
          copyMedia.run(mediaId, recording.id);
          copyTranscript.run(transcriptId, mediaId, source);
          copyWords.run(transcriptId, source);
        }
        // 20 corrections a recording, each with a word on both sides.
        for (let c = 0; c < 20; c++) {
          const position = 1 + c * 2;
          const n = m * 20 + c;
          insert.run(
            randomUUID(),
            mediaId,
            transcriptId,
            position,
            0,
            JSON.stringify([`termo${position}`]),
            `Certo${n % 2_000}`,
            AT,
          );
        }
      }
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
    expect(body?.rules[0]?.contextBefore).toMatch(/^termo\d+$/);
    expect(p95(samples)).toBeLessThanOrEqual(400 * budget);
  }, 180_000);
});
