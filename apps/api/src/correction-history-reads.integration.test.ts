import { describe, expect, it } from 'vitest';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteTranscriptCorrectionStore } from './adapters/sqlite/sqlite-transcript-correction-store.js';
import type { CorrectionRow } from './ports/transcript-correction-store.js';
import type { StoredWord } from './ports/transcript-store.js';
import type { MediaActor } from './modules/media/index.js';
import { CorrectionService } from './modules/media-corrections/correction-service.js';
import {
  LEARNING_NAME,
  LEARNING_PRINCIPAL,
} from './modules/media-corrections/learning-rules.js';

const AT = '2026-11-09T10:00:00.000Z';
const OCCURRENCES = 300;

/** Counts the word reads the history makes (ND-19). */
class CountingStore extends SqliteTranscriptCorrectionStore {
  reads = 0;

  override wordsAt(
    transcriptId: string,
    position: number,
    count: number,
  ): StoredWord[] {
    this.reads++;
    return super.wordsAt(transcriptId, position, count);
  }
}

/** A recording whose transcript says "Atlântida" in 300 places, all put there by one rule. */
function learnedGroup() {
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes,
       status, created_at, updated_at)
     VALUES ('rec', 'udv', 'Palestra', 'outros-autores', 'owner', 'a.m4a', 1, 'ready', ?, ?)`,
  ).run(AT, AT);
  db.prepare(
    `INSERT INTO transcripts (id, media_id, version, provider, model, parameters,
       parameters_version, terms_version, vad, speech_ratio, elapsed_ms, raw_path,
       filter_version, confidence_version, confidence, word_count, removed_words,
       low_words, created_at)
     VALUES ('t1', 'rec', 1, 'mlx-whisper', 'm', '{}', '1', 1, 'applied', 1, 0, 'r.json',
       1, 1, 'normal', 0, 0, 0, ?)`,
  ).run(AT);
  const word = db.prepare(
    `INSERT INTO words (transcript_id, position, segment_position, start_ms, end_ms, text)
     VALUES ('t1', ?, ?, ?, ?, ?)`,
  );
  const store = new CountingStore(db);
  for (let n = 0; n < OCCURRENCES; n++) {
    // The last one was corrected over by a person: it no longer says the learned text.
    const said = n === OCCURRENCES - 1 ? 'Amanta' : 'Atlântida';
    word.run(n * 2, n, n * 800, n * 800 + 400, 'com');
    word.run(n * 2 + 1, n, n * 800 + 400, n * 800 + 800, said);
    store.insert(learned(n * 2 + 1, n));
  }
  return store;
}

const learned = (position: number, segment: number): CorrectionRow => ({
  id: `00000000-0000-4000-8000-${String(position).padStart(12, '0')}`,
  mediaId: 'rec',
  transcriptId: 't1',
  version: 1,
  revision: 1,
  kind: 'correct',
  position,
  count: 1,
  segment,
  startMs: 0,
  endMs: 400,
  before: ['Manta'],
  after: 'Atlântida',
  reverts: null,
  state: 'active',
  carriedTo: null,
  checkedVersion: null,
  found: null,
  groupId: '11111111-1111-4111-8111-111111111111',
  ruleId: 'a'.repeat(32),
  authorPrincipal: LEARNING_PRINCIPAL,
  authorName: LEARNING_NAME,
  createdAt: AT,
});

const member: MediaActor = {
  principal: 'maria',
  isMaster: false,
  canUpload: false,
  canSee: () => true,
};

describe('Correções: a learned group (KBC-113, review round 2, ND-19)', () => {
  it('reads the words of a page once per transcript, however many learned rows it holds', () => {
    const store = learnedGroup();
    const service = new CorrectionService({
      store,
      media: { get: () => ({}) },
      recordOf: () => null,
    });

    const page = service.history(member, 'rec');

    const items = page.entries.flatMap((entry) => entry.items);
    expect(items).toHaveLength(OCCURRENCES);
    expect(store.reads).toBeLessThanOrEqual(1);
    expect(items.filter((item) => item.canUndo)).toHaveLength(OCCURRENCES - 1);
    expect(items.at(-1)?.canUndo).toBe(false);
  });
});
