/**
 * The tables of one unit of the import (ADR 0038 §2): a recording and its tracks. Each table
 * says how its rows reach the unit's media ids, in an order that keeps every foreign key
 * pointing at a row already written. `fingerprint: false` marks what production writes by
 * itself (the queue's history, the documents' publication state): it never makes a unit
 * look changed.
 */
export type UnitKey =
  'media' | 'media_id' | 'transcript' | 'diarization' | 'run';

export interface UnitTable {
  readonly name: string;
  readonly key: UnitKey;
  readonly fingerprint: boolean;
}

const content = (name: string, key: UnitKey): UnitTable => ({
  name,
  key,
  fingerprint: true,
});

export const UNIT_TABLES: readonly UnitTable[] = [
  content('media', 'media'),
  content('media_files', 'media_id'),
  content('transcripts', 'media_id'),
  content('segments', 'transcript'),
  content('words', 'transcript'),
  content('diarizations', 'media_id'),
  content('media_speaker_turns', 'diarization'),
  content('media_segment_voices', 'diarization'),
  content('media_word_voices', 'diarization'),
  content('media_voice_labels', 'diarization'),
  content('media_voice_refusals', 'diarization'),
  content('media_waveforms', 'media_id'),
  content('media_silence_maps', 'media_id'),
  content('media_silences', 'media_id'),
  content('media_edits', 'media_id'),
  content('media_proposal_runs', 'media_id'),
  content('media_draft_tracks', 'media_id'),
  content('media_tracks', 'media_id'),
  content('media_voice_suggestions', 'run'),
  content('media_preparations', 'media_id'),
  content('media_transcribe_cuts', 'media_id'),
  content('media_subject_runs', 'media_id'),
  content('media_track_subjects', 'media_id'),
  content('media_subject_links', 'media_id'),
  content('media_track_changes', 'media_id'),
  content('media_track_archive', 'media_id'),
  content('media_track_old_files', 'media_id'),
  content('transcript_corrections', 'media_id'),
  { name: 'jobs', key: 'media_id', fingerprint: false },
  { name: 'media_documents', key: 'media_id', fingerprint: false },
];

/** The content tables a replacement rewrites: never `media` (people's rows hang on it). */
export const REWRITTEN_TABLES = UNIT_TABLES.filter(
  (table) => table.fingerprint && table.name !== 'media',
);

/** Only the queue's history goes: production never runs what the Mac queued (BR-1). */
export const TERMINAL_JOBS = `status IN ('done', 'failed', 'dead') AND kind <> 'voice-profile'`;

const IDS = `(SELECT value FROM json_each(:ids))`;

/** The SQL condition on `<schema>.<table>` (alias `x`) for the unit whose ids are `:ids`. */
export function unitFilter(table: UnitTable, schema: string): string {
  const byKey: Record<UnitKey, string> = {
    media: `x.id IN ${IDS}`,
    media_id: `x.media_id IN ${IDS}`,
    transcript: `x.transcript_id IN (SELECT id FROM ${schema}.transcripts WHERE media_id IN ${IDS})`,
    diarization: `x.diarization_id IN (SELECT id FROM ${schema}.diarizations WHERE media_id IN ${IDS})`,
    run: `x.run_id IN (SELECT id FROM ${schema}.media_proposal_runs WHERE media_id IN ${IDS})`,
  };
  const filter = byKey[table.key];
  return table.name === 'jobs' ? `${filter} AND ${TERMINAL_JOBS}` : filter;
}

/** Every file a unit's rows name, relative to the media folder (ADR 0022 §1). */
export function unitFilesQuery(schema: string): string {
  return `
    SELECT path FROM ${schema}.media_files WHERE media_id IN ${IDS}
    UNION SELECT raw_path FROM ${schema}.transcripts WHERE media_id IN ${IDS} AND raw_path <> ''
    UNION SELECT raw_path FROM ${schema}.diarizations WHERE media_id IN ${IDS} AND raw_path <> ''
    UNION SELECT path FROM ${schema}.media_track_old_files WHERE media_id IN ${IDS}
    UNION SELECT cut_path FROM ${schema}.media_tracks WHERE media_id IN ${IDS} AND cut_path IS NOT NULL
    ORDER BY 1`;
}

/**
 * A path the import may read from the package and write under the media folder: one of the
 * app's own folders, no climbing out, no hidden or voice-print file (ADR 0032).
 */
export function isSafeMediaPath(path: string): boolean {
  if (!/^(audio|transcripts)\/[A-Za-z0-9._/-]+$/.test(path)) return false;
  return !path
    .split('/')
    .some((part) => part === '' || part === '..' || part.startsWith('.'));
}
