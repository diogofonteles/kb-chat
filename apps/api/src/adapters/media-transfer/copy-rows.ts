import type { DatabaseSync } from 'node:sqlite';
import { unitFilter, type UnitTable } from './unit-tables.js';

/**
 * Copies rows from the attached package (`src`) into production (`main`) with plain
 * INSERT … SELECT: names come from the schema (both sides run the same migrations, BR-9),
 * values never pass through a string. Columns that name a person, a speaker, a subject or a
 * level go through the run's temporary maps (BR-5, BR-6).
 */
type ColumnRule = (ref: string) => string;

const mapped =
  (map: string): ColumnRule =>
  (ref) =>
    `COALESCE((SELECT dst FROM temp.${map} WHERE src = ${ref}), ${ref})`;
const person = mapped('principal_map');
const speaker = mapped('speaker_map');
const subject = mapped('subject_map');
const nothing: ColumnRule = () => 'NULL';

const RULES: Readonly<Record<string, Readonly<Record<string, ColumnRule>>>> = {
  media: {
    owner_principal: person,
    level: () => '(SELECT level FROM temp.level_map WHERE media_id = x.id)',
  },
  media_tracks: {
    approved_by: person,
    asker_speaker_id: speaker,
    answerer_speaker_id: speaker,
  },
  media_draft_tracks: {
    asker_speaker_id: speaker,
    answerer_speaker_id: speaker,
  },
  media_track_archive: {
    asker_speaker_id: speaker,
    answerer_speaker_id: speaker,
  },
  media_voice_labels: { speaker_id: speaker },
  media_edits: { updated_by: person },
  media_preparations: { principal: person },
  media_subject_runs: { principal: person },
  media_track_subjects: { updated_by: person },
  // A free subject's key names its id ('free:<id>'): it follows the id production keeps.
  media_subject_links: {
    decided_by: person,
    subject_id: subject,
    subject_key: (ref) =>
      `CASE WHEN x.kind = 'free' THEN 'free:' || ${subject('x.subject_id')} ELSE ${ref} END`,
  },
  media_track_changes: { principal: person },
  media_voice_refusals: { refused_by: person },
  media_proposal_runs: { principal: person },
  transcript_corrections: { author_principal: person },
  jobs: { lease_id: nothing, lease_until: nothing, heartbeat_at: nothing },
  media_documents: { live_sha256: nothing, live_at: nothing },
  media_speakers: { created_by: person },
  media_subjects: { created_by: person },
  term_versions: { author_principal: person },
  learning_switches: { author_principal: person },
  media_progress: { principal: person },
  media_bookmarks: { principal: person },
  media_moved_bookmarks: { principal: person },
  media_preferences: { principal: person },
  media_library_state: { principal: person },
};

/** The table's columns, in the order the schema has them. */
export function columnsOf(
  db: DatabaseSync,
  schema: string,
  table: string,
): string[] {
  return db
    .prepare(`SELECT name FROM pragma_table_info(?, ?) ORDER BY cid`)
    .all(table, schema)
    .map((row) => String(row['name']));
}

/** `src.<table> x`'s columns as production should store them. */
export function selectedColumns(db: DatabaseSync, table: string): string {
  const rules = RULES[table] ?? {};
  return columnsOf(db, 'main', table)
    .map((column) => {
      const rule = rules[column];
      return rule ? rule(`x.${column}`) : `x.${column}`;
    })
    .join(', ');
}

const quoted = (columns: readonly string[]): string =>
  columns.map((column) => `"${column}"`).join(', ');

/** INSERT … SELECT of one table's rows for the unit; `extra` narrows it further. */
export function insertUnitRows(
  db: DatabaseSync,
  table: UnitTable,
  options: {
    readonly ids: string;
    readonly extra?: string;
    readonly verb?: string;
    readonly params?: Readonly<Record<string, string>>;
  },
): number {
  const columns = columnsOf(db, 'main', table.name);
  const where = [unitFilter(table, 'src'), options.extra]
    .filter(Boolean)
    .join(' AND ');
  const result = db
    .prepare(
      `${options.verb ?? 'INSERT'} INTO main.${table.name} (${quoted(columns)})
       SELECT ${selectedColumns(db, table.name)} FROM src.${table.name} x WHERE ${where}`,
    )
    .run({ ids: options.ids, ...options.params });
  return Number(result.changes);
}

/** INSERT OR IGNORE of rows chosen by `where` (shared and personal tables). */
export function insertMissingRows(
  db: DatabaseSync,
  table: string,
  where: string,
): number {
  const columns = columnsOf(db, 'main', table);
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO main.${table} (${quoted(columns)})
       SELECT ${selectedColumns(db, table)} FROM src.${table} x WHERE ${where}`,
    )
    .run();
  return Number(result.changes);
}

/**
 * Updates production's rows of a unit's media from the package, all columns but the id and
 * the level, which belongs to production after the first import (BR-6).
 */
export function updateMediaRows(db: DatabaseSync, ids: string): void {
  const columns = columnsOf(db, 'main', 'media').filter(
    (column) => column !== 'id' && column !== 'level',
  );
  const values = columns
    .map((column) =>
      (RULES['media']?.[column] ?? ((ref: string) => ref))(`x.${column}`),
    )
    .join(', ');
  db.prepare(
    `UPDATE main.media SET (${quoted(columns)}) =
       (SELECT ${values} FROM src.media x WHERE x.id = main.media.id)
     WHERE id IN (SELECT value FROM json_each(:ids))
       AND id IN (SELECT id FROM src.media)`,
  ).run({ ids });
}
