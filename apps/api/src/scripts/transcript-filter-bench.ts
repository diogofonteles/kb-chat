// How long the post-filter takes on large raw results (KBC-036 review: no quadratic blow-up
// on the event loop). Manual: pnpm --filter @kb-chat/api exec tsx src/scripts/transcript-filter-bench.ts [raw.json]
import { readFileSync } from 'node:fs';
import { rawTranscriptSchema, type RawTranscript } from '@kb-chat/contracts';
import { confidenceOf, deriveTranscript } from '../modules/media/index.js';

const words = (texts: string[], start: number) =>
  texts.map((word, index) => ({
    word: ` ${word}`,
    start: start + index * 0.3,
    end: start + index * 0.3 + 0.2,
  }));

/** `count` words in 25-word segments, each made by `wordAt`. */
function synthetic(
  count: number,
  wordAt: (index: number) => string,
): RawTranscript {
  const segments = [];
  for (let first = 0; first < count; first += 25) {
    const texts = Array.from({ length: Math.min(25, count - first) }, (_, i) =>
      wordAt(first + i),
    );
    const start = first * 0.3;
    segments.push({
      start,
      end: start + texts.length * 0.3,
      text: texts.join(' '),
      words: words(texts, start),
    });
  }
  return { chunks: [{ offset: 0, end: count * 0.3, result: { segments } }] };
}

function time(label: string, raw: RawTranscript): void {
  const started = performance.now();
  const derived = deriveTranscript(raw, []);
  confidenceOf(derived);
  const ms = performance.now() - started;
  console.log(
    `${label}: ${derived.stats.wordsBefore} words in, ${derived.words.length} out, ${ms.toFixed(0)} ms`,
  );
}

const file = process.argv[2];
if (file) {
  const raw = rawTranscriptSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  time('pilot track', raw);
  time('pilot track x10', {
    chunks: Array.from({ length: 10 }, () => raw.chunks).flat(),
  });
}
const vocabulary = [
  'a',
  'casa',
  'do',
  'mestre',
  'é',
  'luz',
  'vegetal',
  'sessão',
  'caminho',
];
time(
  '60k words of speech',
  synthetic(60_000, (i) => vocabulary[(i * 7 + (i >> 3)) % 9] ?? 'a'),
);
time(
  '60k words, one 1-word loop',
  synthetic(60_000, () => 'sim'),
);
time(
  '60k words, 12-word loops',
  synthetic(60_000, (i) => `w${i % 12}`),
);
time(
  '60k words, nested loops',
  synthetic(60_000, (i) => (i % 4 === 3 ? 'y' : 'x')),
);
time(
  '60k words, 13-word cycle (no loop)',
  synthetic(60_000, (i) => `w${i % 13}`),
);
