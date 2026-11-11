// KBC-101 NFR-3: a test collection for `pnpm --filter @kb-chat/api latency` against a running
// API. Copies the fixture vault to `<out>/vault` and, with `--tracks N`, adds N synthetic
// track documents to its `hermetismo` collection and their tracks to `<out>/media/media.db`
// (ready, with transcripts), so the media.db check is counted. The tracks speak with the
// latency script's own words, so its questions find them. Index `<out>/vault` with QMD
// before starting the API on it (the E2E server reads KBC_BENCH_VAULT, KBC_BENCH_MEDIA_DIR).
// `--as-texts` writes the same files without their `kb_chat_*` keys: the same index and
// transcripts, read as texts, to tell this app's track work from the index's growth.
// Usage: tsx src/scripts/seed-track-world.ts --out <dir> [--tracks 2000] [--as-texts]
import { cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LATENCY_QUERIES } from './latency-queries.js';
import { trackDatabase, writeTrackDocuments } from './track-world.js';

const valueOf = (name: string): string | undefined => {
  const at = process.argv.indexOf(name);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const OUT = valueOf('--out');
const TRACKS = Number(valueOf('--tracks') ?? '2000');
const AS_TEXTS = process.argv.includes('--as-texts');
if (!OUT || !Number.isInteger(TRACKS) || TRACKS < 0)
  throw new Error('usage: seed-track-world.ts --out <dir> [--tracks 2000]');

const TOPIC = 'hermetismo';
/** The latency questions' words and some talk around them. */
const WORDS = [
  ...new Set(
    LATENCY_QUERIES.join(' ')
      .toLowerCase()
      .split(/[^\p{L}\d]+/u)
      .filter((word) => word.length > 3),
  ),
  ...'então quando porque sempre também ainda muito pouco nosso vida tudo nada mestre irmão palavra caminho trabalho estudo prática sentido'.split(
    ' ',
  ),
];
const words = (seed: number, count: number): string =>
  Array.from(
    { length: count },
    (_, i) => WORDS[(seed * 31 + i * 17) % WORDS.length],
  ).join(' ');

const fixture = fileURLToPath(
  new URL('../../test/fixtures/vault', import.meta.url),
);
const vault = join(OUT, 'vault');
const media = join(OUT, 'media');
cpSync(fixture, vault, { recursive: true });
mkdirSync(media, { recursive: true });
const world = { topic: TOPIC, tracks: TRACKS, words };
writeTrackDocuments(join(vault, TOPIC), world, { asTexts: AS_TEXTS });
trackDatabase(media, world).close();
process.stdout.write(
  `${OUT}: the fixture vault and ${TRACKS} track documents in ${TOPIC}${AS_TEXTS ? ', as texts' : ''}\n`,
);
