// Latency fitness function (docs/architecture/overview.md, Q1/Q2): p95 per search mode
// against a running API. Starts as a warning (QA-16): prints and exits 0 unless --strict.
import { LATENCY_QUERIES } from './latency-queries.js';

const API = process.env['KB_CHAT_API'] ?? 'http://127.0.0.1:3000';
const TOPIC = process.env['KB_TOPIC'] ?? 'hermetismo';
const STRICT = process.argv.includes('--strict');
/**
 * A signed-in session for an API that requires one (KBC-010): the `Cookie` header's value,
 * from the environment so it never shows in the command line.
 */
const COOKIE = process.env['KB_CHAT_COOKIE'];
/** Searches per question and mode (KBC-101 NFR-3 asks for more than one pass). */
const ROUNDS = Number(process.env['KB_CHAT_LATENCY_ROUNDS'] ?? '1');

const THRESHOLD_MS = { exact: 1_000, semantic: 2_000, all: 4_000 } as const;
type Mode = keyof typeof THRESHOLD_MS;

const p95 = (samples: number[]): number => {
  const sorted = [...samples].sort((a, b) => a - b);
  return (
    sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ??
    0
  );
};

async function timeQuery(q: string, mode: Mode): Promise<number> {
  const started = performance.now();
  const response = await fetch(`${API}/api/v1/topics/${TOPIC}/searches`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-requested-with': 'kb-chat',
      ...(COOKIE && { cookie: COOKIE }),
    },
    body: JSON.stringify({ q, mode }),
  });
  if (!response.ok)
    throw new Error(`${mode} "${q}" failed with ${response.status}`);
  await response.json();
  return performance.now() - started;
}

let failed = false;
for (const mode of Object.keys(THRESHOLD_MS) as Mode[]) {
  const samples: number[] = [];
  const asked = Array.from({ length: ROUNDS }, () => LATENCY_QUERIES).flat();
  for (const q of asked) samples.push(await timeQuery(q, mode));
  const value = Math.round(p95(samples));
  const ok = value <= THRESHOLD_MS[mode];
  failed ||= !ok;
  process.stdout.write(
    `${mode.padEnd(8)} p95 ${value} ms (limit ${THRESHOLD_MS[mode]} ms) ${ok ? 'OK' : 'WARN'}\n`,
  );
}
process.exit(failed && STRICT ? 1 : 0);
