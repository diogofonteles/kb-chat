// Calibration of the transcript post-filter and confidence (KBC-036 FR-4, NFR-3, ADR 0023
// §5-6): derives every raw JSON in a folder (the pilot's `out/<variant>/raw`) and prints,
// per track, the words, what the filter removed, the doubted share and the verdict, then
// the loops still left. A manual check: run it again when the filter or the rules change.
//   pnpm --filter @kb-chat/api exec tsx src/scripts/transcript-calibration.ts <raw-dir>
import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { rawTranscriptSchema } from '@kb-chat/contracts';
import { openMediaDatabase } from '../adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../adapters/sqlite/media-migrations.js';
import { SqliteTranscriptStore } from '../adapters/sqlite/sqlite-transcript-store.js';
import { confidenceOf, deriveTranscript } from '../modules/media/index.js';

const dir = process.argv[2];
if (!dir) throw new Error('usage: transcript-calibration.ts <raw-dir>');
const terms = new SqliteTranscriptStore(
  openMediaDatabase(':memory:', MEDIA_MIGRATIONS),
).currentTerms().terms;

const token = (text: string) =>
  text.toLocaleLowerCase('pt-BR').replace(/[^\p{L}\p{N}]+/gu, '');

/** True when the `size` tokens at `start` repeat 3 times in a row. */
function loopsAt(tokens: readonly string[], start: number, size: number) {
  const part = (k: number) =>
    tokens.slice(start + k * size, start + (k + 1) * size).join(' ');
  const unit = part(0);
  return unit !== '' && part(1) === unit && part(2) === unit;
}

/** Loops of 1–12 words repeated 3 or more times in a row (NFR-3). */
function loopsLeft(tokens: readonly string[]): number {
  let loops = 0;
  for (let start = 0; start < tokens.length; start++) {
    const sizes = Array.from({ length: 12 }, (_, i) => i + 1);
    if (sizes.some((size) => loopsAt(tokens, start, size))) loops++;
  }
  return loops;
}

let totalLoops = 0;
console.log(
  'track\twords_before\tremoved\tremoved_%\tdoubted_%\tconfidence\tloops_left',
);
for (const file of readdirSync(dir)
  .filter((name) => name.endsWith('.json'))
  .sort()) {
  const raw = rawTranscriptSchema.parse(
    JSON.parse(readFileSync(join(dir, file), 'utf8')),
  );
  const derived = deriveTranscript(raw, terms);
  const verdict = confidenceOf(derived);
  const loops = loopsLeft(
    derived.words.map((word) => token(word.text)).filter(Boolean),
  );
  totalLoops += loops;
  const { wordsBefore, removedWords } = derived.stats;
  const pct = (part: number, whole: number) =>
    ((100 * part) / Math.max(1, whole)).toFixed(1);
  console.log(
    [
      basename(file, '.json'),
      wordsBefore,
      removedWords,
      pct(removedWords, wordsBefore),
      pct(verdict.doubtedWords, verdict.wordCount),
      verdict.confidence,
      loops,
    ].join('\t'),
  );
}
console.log(`loops left in all tracks: ${totalLoops}`);
