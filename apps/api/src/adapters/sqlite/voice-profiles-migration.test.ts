import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { applyMigrations } from './media-database.js';
import { MEDIA_MIGRATIONS } from './media-migrations.js';

const BEFORE = MEDIA_MIGRATIONS.filter(({ version }) => version < 15);
const AT = '2026-11-04T12:00:00.000Z';

describe('media migration 15 (KBC-071)', () => {
  let db: DatabaseSync;
  afterEach(() => db.close());

  function open(): void {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
  }

  function anItemWithAJob(): void {
    db.exec(`INSERT INTO media (id, topic, title, authorship, owner_principal, file_name,
        upload_bytes, status, created_at, updated_at)
      VALUES ('m1', 'udv', 'A', 'outros-autores', 'a', 'a.mp3', 3, 'ready', '${AT}', '${AT}')`);
    db.exec(`INSERT INTO jobs (id, media_id, kind, status, voices, created_at, updated_at)
      VALUES ('j1', 'm1', 'diarize', 'queued', 2, '${AT}', '${AT}')`);
    db.exec(`INSERT INTO media_speakers (id, collection, name, name_key, created_by,
        created_at, updated_at) VALUES ('s1', 'udv', 'Ana', 'ana', 'a', '${AT}', '${AT}')`);
  }

  const aConsent = (id: string) =>
    db.exec(`INSERT INTO voice_consents (id, collection, speaker_id, speaker_name, subject,
        granted_by, granted_on, method, purpose, text_version, registered_by, registered_at)
      VALUES ('${id}', 'udv', 's1', 'Ana', 'living', 'Ana', '2026-10-01', 'email',
        'suggest-names-when-editing', 1, 'a', '${AT}')`);
  const aProfile = (id: string, consent: string) =>
    db.exec(`INSERT INTO voice_profiles (id, consent_id, speaker_id, collection, created_at,
        updated_at) VALUES ('${id}', '${consent}', 's1', 'udv', '${AT}', '${AT}')`);

  it('keeps the jobs made before it, with every column', () => {
    open();
    applyMigrations(db, BEFORE);
    anItemWithAJob();
    expect(applyMigrations(db, MEDIA_MIGRATIONS)).toEqual([15]);
    expect(
      db.prepare('SELECT id, kind, voices, voice_profile_id FROM jobs').all(),
    ).toEqual([
      { id: 'j1', kind: 'diarize', voices: 2, voice_profile_id: null },
    ]);
  });

  it('has no table or column that could hold a print', () => {
    open();
    applyMigrations(db, MEDIA_MIGRATIONS);
    const columns = db
      .prepare(
        `SELECT p.name FROM sqlite_master m, pragma_table_info(m.name) p
         WHERE m.type = 'table' AND m.name LIKE 'voice_%'`,
      )
      .all()
      .map((row) => String(row['name']));
    expect(columns.join(' ')).not.toMatch(/embedding|vector|print/);
  });

  it('allows no profile without a consent (BR-1)', () => {
    open();
    applyMigrations(db, MEDIA_MIGRATIONS);
    anItemWithAJob();
    expect(() => aProfile('p1', 'none')).toThrow();
    aConsent('c1');
    aProfile('p1', 'c1');
    expect(() =>
      db.exec(`INSERT INTO jobs (id, media_id, kind, status, created_at, updated_at)
        VALUES ('j2', 'm1', 'voice-profile', 'queued', '${AT}', '${AT}')`),
    ).toThrow();
  });

  it('takes the job with the profile, and keeps the consent', () => {
    open();
    applyMigrations(db, MEDIA_MIGRATIONS);
    anItemWithAJob();
    aConsent('c1');
    aProfile('p1', 'c1');
    db.exec(`INSERT INTO jobs (id, media_id, kind, status, voice_profile_id, created_at,
        updated_at) VALUES ('j2', 'm1', 'voice-profile', 'queued', 'p1', '${AT}', '${AT}')`);
    db.exec(`DELETE FROM voice_profiles WHERE id = 'p1'`);
    expect(
      db.prepare(`SELECT id FROM jobs WHERE kind = 'voice-profile'`).all(),
    ).toEqual([]);
    expect(db.prepare('SELECT id FROM voice_consents').all()).toHaveLength(1);
  });
});
