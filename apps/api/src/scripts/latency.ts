// Latency fitness function (docs/architecture/overview.md, Q1/Q2): p95 per search mode
// against a running API. Starts as a warning (QA-16): prints and exits 0 unless --strict.
const API = process.env['KB_CHAT_API'] ?? 'http://127.0.0.1:3000';
const TOPIC = process.env['KB_TOPIC'] ?? 'hermetismo';
const STRICT = process.argv.includes('--strict');

const QUERIES = [
  'natureza sétupla',
  'lei do ritmo',
  'como se proteger de energias negativas',
  'o que é carma',
  'reencarnação',
  'árvore da vida cabala',
  'elementais',
  'meditação',
  'corpo astral',
  'alquimia interior',
  'princípio de correspondência',
  'gnosticismo',
  'numerologia do número sete',
  'mente e consciência',
  'iniciação hermética',
  'tempo e eterno agora',
  'magia ritual',
  'sugadores de energia',
  'Hermes Trismegisto',
  'evolução da mônada',
];
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
    headers: { 'content-type': 'application/json' },
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
  for (const q of QUERIES) samples.push(await timeQuery(q, mode));
  const value = Math.round(p95(samples));
  const ok = value <= THRESHOLD_MS[mode];
  failed ||= !ok;
  process.stdout.write(
    `${mode.padEnd(8)} p95 ${value} ms (limit ${THRESHOLD_MS[mode]} ms) ${ok ? 'OK' : 'WARN'}\n`,
  );
}
process.exit(failed && STRICT ? 1 : 0);
