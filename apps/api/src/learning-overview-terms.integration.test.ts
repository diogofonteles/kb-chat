import { describe, expect, it } from 'vitest';
import { openMediaDatabase } from './adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from './adapters/sqlite/media-migrations.js';
import { SqliteTranscriptCorrectionStore } from './adapters/sqlite/sqlite-transcript-correction-store.js';
import { SqliteTranscriptStore } from './adapters/sqlite/sqlite-transcript-store.js';
import { LearningService } from './modules/media-corrections/learning-service.js';

const AT = '2026-11-09T10:00:00.000Z';

/** Two names corrected by people, each in a recording of its own. */
function twoNames() {
  const db = openMediaDatabase(':memory:', MEDIA_MIGRATIONS);
  db.prepare(
    `INSERT INTO media (id, topic, title, authorship, owner_principal, file_name, upload_bytes,
       status, created_at, updated_at)
     VALUES ('rec', 'udv', 'Palestra', 'outros-autores', 'owner', 'a.m4a', 1, 'ready', ?, ?)`,
  ).run(AT, AT);
  const insert = db.prepare(
    `INSERT INTO transcript_corrections (id, media_id, transcript_id, version, revision, kind,
       first_position, word_count, segment_position, start_ms, end_ms, before, after, state,
       author_principal, created_at)
     VALUES (?, 'rec', 't1', 1, 1, 'correct', ?, 1, 0, 0, 400, ?, ?, 'active', 'owner', ?)`,
  );
  insert.run('c1', 1, '["Alfa"]', 'Álefe', AT);
  insert.run('c2', 3, '["Beta"]', 'Bétis', '2026-11-09T09:00:00.000Z');
  return {
    corrections: new SqliteTranscriptCorrectionStore(db),
    transcripts: new SqliteTranscriptStore(db),
  };
}

describe('LearningService: the terms masters see are the terms sent (review round 2, S1)', () => {
  it('a learned term the real count leaves out reads "no room" in the overview too', () => {
    const stores = twoNames();
    // A count that is not the sum of its terms: the two names together cost much more.
    const countTokens = (list: readonly string[]) =>
      list.length +
      (list.includes('Álefe') && list.includes('Bétis') ? 1_000 : 0);
    const learning = new LearningService({ ...stores, countTokens });

    const sent = learning.termsForTranscriber().terms;
    const shown = learning.overview().terms;

    expect(sent).toContain('Álefe');
    expect(sent).not.toContain('Bétis');
    expect(shown.map((term) => [term.term, term.state])).toEqual([
      ['Álefe', 'in-list'],
      ['Bétis', 'no-room'],
    ]);
  });
});
