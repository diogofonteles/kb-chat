import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteMediaDocumentStore } from './adapters/sqlite/sqlite-media-document-store.js';
import { SqliteMediaStore } from './adapters/sqlite/sqlite-media-store.js';
import { SqliteTranscriptStore } from './adapters/sqlite/sqlite-transcript-store.js';
import { trackDatabase, trackId } from './scripts/track-world.js';
import {
  SHELF_BULK_AFTER,
  MediaTrackShelf,
} from './modules/media-documents/index.js';

const TRACKS = 80;
let dir: string | undefined;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** 80 ready tracks in "udv"; one archived, one moved, one in a recording still preparing. */
function world(): DatabaseSync {
  dir = mkdtempSync(join(tmpdir(), 'kbchat-shelf-'));
  const db = trackDatabase(dir, {
    topic: 'udv',
    tracks: TRACKS,
    words: (seed, count) => `palavra${seed} `.repeat(count),
  });
  const set = (sql: string, id: string) => db.prepare(sql).run(id);
  set(`UPDATE media SET archived_at = '2026-11-09' WHERE id = ?`, trackId(5));
  set(`UPDATE media SET topic = 'outro' WHERE id = ?`, trackId(7));
  set(`UPDATE media SET status = 'processing' WHERE id = ?`, trackId(11));
  set(
    `UPDATE transcripts SET confidence = 'low' WHERE media_id = ?`,
    trackId(9),
  );
  return db;
}

function shelves(db: DatabaseSync) {
  const deps = {
    store: new SqliteMediaStore(db),
    transcripts: new SqliteTranscriptStore(db),
  };
  const documents = new SqliteMediaDocumentStore(db);
  const loads: string[] = [];
  const bulk = new MediaTrackShelf({
    ...deps,
    rowsOf: (topic) => {
      loads.push(topic);
      return documents.shelfRows(topic);
    },
  });
  return { single: new MediaTrackShelf(deps), bulk, loads };
}

describe('MediaTrackShelf (ADR 0035 §5, KBC-101 NFR-3)', () => {
  it('answers from one read of the collection once many tracks are asked, as track by track', () => {
    const { single, bulk, loads } = shelves(world());
    for (const topic of ['udv', 'outro'])
      for (let n = 0; n < TRACKS; n++) {
        const query = { mediaId: trackId(n) };
        expect(bulk.trackOf(topic, query), `${topic} ${n}`).toEqual(
          single.trackOf(topic, query),
        );
      }
    expect(bulk.trackOf('udv', { mediaId: trackId(5) })).toBeNull();
    expect(bulk.trackOf('udv', { mediaId: trackId(9) })?.confidence).toBe(
      'low',
    );
    expect(loads).toEqual(['udv', 'outro']);
  });

  it('asks track by track while few are asked', () => {
    const { bulk, loads } = shelves(world());
    for (let n = 0; n < SHELF_BULK_AFTER; n++)
      bulk.trackOf('udv', { mediaId: trackId(n) });
    expect(loads).toEqual([]);
  });
});
