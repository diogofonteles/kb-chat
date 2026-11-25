import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { DocIngestJob, DocIngestSource } from '@kb-chat/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PUBLIC } from '../modules/auth/index.js';
import type { CatalogRegistry } from '../modules/catalog/index.js';
import type { DocIngestWork } from '../modules/document-uploads/index.js';

const WORKER = 'transcriber:e2e-mac';
/** A link whose host says so does not convert (KBC-149 AC-4). */
const BROKEN_HOST = /quebrado/;
/** And one whose host says so has nothing to read: kb puts it in its quarantine. */
const SHALLOW_HOST = /^https?:\/\/raso\.example\//;
const QUARANTINE = 'raw/_quarantine/articles/';

const runBody = z.object({
  topic: z.string().min(1),
  /** Takes one and stays at it: what the screen shows meanwhile (KBC-184). */
  hold: z.boolean().default(false),
});

const slugOf = (name: string): string =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '') || 'documento';

const extensionOf = (name: string): string =>
  /\.([a-z0-9]{1,10})$/i.exec(name)?.[1]?.toLowerCase() ?? 'bin';

/**
 * The E2E server only (KBC-149): plays the owner's Mac on the real doc-ingest queue, with a
 * fake kb-map convert and kb. A file becomes a document with its original kept (so "Ver
 * original" works), a link a document of its page, a link to a "quebrado" host a failure
 * with why; then the collection is read again, as production's catalog after a sync.
 */
export function registerDocIngestMac(
  app: FastifyInstance,
  input: {
    queue: () => DocIngestWork | null;
    vault: string;
    catalog: CatalogRegistry;
  },
): void {
  app.post(
    '/api/e2e/doc-ingest/run',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { topic, hold } = runBody.parse(request.body);
      const queue = input.queue();
      if (!queue) return reply.code(404).send();
      if (hold) {
        await takeAndHold(queue, topic);
        return reply.code(200).send({ done: 0 });
      }
      const done = await ingestAll(queue, { topic, vault: input.vault });
      await input.catalog.refresh(topic);
      return reply.code(200).send({ done });
    },
  );
}

type Owner = Parameters<DocIngestWork['step']>[0];

async function ingestAll(
  queue: DocIngestWork,
  { topic, vault }: { topic: string; vault: string },
): Promise<number> {
  let done = 0;
  for (
    let job = queue.lease(WORKER, topic);
    job;
    job = queue.lease(WORKER, topic)
  ) {
    await ingest(queue, { job, vault });
    done += 1;
  }
  return done;
}

async function takeAndHold(queue: DocIngestWork, topic: string) {
  const job = queue.lease(WORKER, topic);
  if (!job) return;
  const owner = { jobId: job.id, worker: WORKER, leaseId: job.leaseId };
  await queue.step(owner, { ...owner, state: 'classifying' });
}

async function ingest(
  queue: DocIngestWork,
  input: { job: DocIngestJob; vault: string },
): Promise<void> {
  const { job } = input;
  const owner = { jobId: job.id, worker: WORKER, leaseId: job.leaseId };
  const { source } = job;
  if (source.kind === 'remove' || source.kind === 'restore') {
    await move(input.vault, job.topic, source);
    return queue.complete(owner, {
      ...owner,
      outcome: { state: 'moved' },
      spendUsd: 0,
    });
  }
  if (source.kind === 'url' && SHALLOW_HOST.test(source.url))
    return refuse(queue, owner, source.url);
  if ('url' in source && BROKEN_HOST.test(source.url))
    return broken(queue, owner);
  if (source.kind === 'list')
    return queue.list(owner, { ...owner, entries: entriesOf(source.url) });
  if (source.kind === 'recording') return bringSound(queue, owner, source.url);
  return write(queue, owner, input);
}

/** Into kb's quarantine or out of it, as kb moves it (KBC-187). */
async function move(
  vault: string,
  topic: string,
  { kind, document }: Extract<DocIngestSource, { kind: 'remove' | 'restore' }>,
): Promise<void> {
  const inside = join(vault, topic, document);
  const apart = join(
    vault,
    topic,
    document.replace(/^raw\//, 'raw/_quarantine/'),
  );
  const [from, to] = kind === 'remove' ? [inside, apart] : [apart, inside];
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

/** kb's quarantine for a page with nothing to read: a person decides (KBC-009). */
const refuse = (
  queue: DocIngestWork,
  owner: Owner,
  link: string,
): Promise<void> =>
  queue.complete(owner, {
    ...owner,
    outcome: {
      state: 'failed',
      failure: 'not-accepted',
      detail: 'kb triage: quarantined',
      refused: {
        document: `${QUARANTINE}${slugOf(link)}.md`,
        reason: 'thin',
        excerpt: `# ${slugOf(link)}\n\nEntrar\n\nEsqueceu a senha?`,
      },
    },
    spendUsd: 0,
  });

const broken = (queue: DocIngestWork, owner: Owner): Promise<void> =>
  queue.complete(owner, {
    ...owner,
    outcome: {
      state: 'failed',
      failure: 'conversion-failed',
      detail: 'firecrawl: HTTP 404; jina: HTTP 404',
    },
    spendUsd: 0,
  });

/** What `yt-dlp --flat-playlist` says of a channel: titles and durations, nothing taken. */
const entriesOf = (link: string) =>
  [1, 2, 3].map((n) => ({
    url: new URL(`/watch?v=${slugOf(link)}-aula${n}`, link).href,
    title: `Aula ${n}`,
    durationS: n * 600,
  }));

async function bringSound(
  queue: DocIngestWork,
  owner: Owner,
  link: string,
): Promise<void> {
  const sound = toneOf(link);
  await queue.adopt(owner, {
    body: Readable.from([sound]),
    bytes: sound.length,
    name: `Gravação ${slugOf(link)}.wav`,
  });
}

async function write(
  queue: DocIngestWork,
  owner: Owner,
  { job, vault }: { job: DocIngestJob; vault: string },
): Promise<void> {
  if (job.collection)
    await makeTopic(vault, { slug: job.topic, title: job.collection.title });
  for (const state of ['classifying', 'mapping'] as const)
    await queue.step(owner, { ...owner, state });
  const document = await converted(queue, { job, vault });
  await queue.complete(owner, {
    ...owner,
    outcome: { state: 'ready', document, review: false },
    spendUsd: 0,
  });
}

/** The sound yt-dlp would bring: a second of a tone, the link's own, so no two are the same. */
function toneOf(link: string): Buffer {
  const rate = 8_000;
  const hertz = 200 + (createHash('sha256').update(link).digest()[0] ?? 0) * 4;
  const samples = Buffer.alloc(rate * 2);
  for (let at = 0; at < rate; at += 1)
    samples.writeInt16LE(
      Math.round(8_000 * Math.sin((2 * Math.PI * hertz * at) / rate)),
      at * 2,
    );
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + samples.length, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

/** What kb-map convert would leave in the vault for the job's file or link. */
async function converted(
  queue: DocIngestWork,
  { job, vault }: { job: DocIngestJob; vault: string },
): Promise<{ id: string; title: string }> {
  const { source } = job;
  if (source.kind === 'accept')
    return writePage(
      vault,
      job.topic,
      `https://raso.example/${source.document.slice(QUARANTINE.length, -'.md'.length)}`,
    );
  if ('url' in source) return writePage(vault, job.topic, source.url);
  if (source.kind !== 'file') throw new Error(`${source.kind} writes nothing`);
  const owner = { jobId: job.id, worker: WORKER, leaseId: job.leaseId };
  const bytes = await readFile((await queue.fileOf(owner)).path);
  return writeUpload(vault, job.topic, { name: source.name, bytes });
}

async function writeUpload(
  vault: string,
  topic: string,
  file: { name: string; bytes: Buffer },
): Promise<{ id: string; title: string }> {
  const sha = createHash('sha256').update(file.bytes).digest('hex');
  const folder = resolve(vault, topic);
  const original = resolve(
    folder,
    'raw',
    '_originals',
    `${sha}.${extensionOf(file.name)}`,
  );
  await put(folder, original, file.bytes);
  const title = file.name.replace(/\.[a-z0-9]+$/i, '');
  const id = `raw/articles/${slugOf(file.name)}.md`;
  const header = [
    `title: "${title}"`,
    'type: source',
    `original_sha256: ${sha}`,
    `original_name: "${file.name}"`,
    'converter: docling',
    'converter_version: "e2e"',
    `source_path: "upload/${file.name}"`,
  ].join('\n');
  const body = `# ${title}\n\n## Capítulo 1\n\nO todo é mente; o universo é mental.\n`;
  await put(folder, resolve(folder, id), `---\n${header}\n---\n\n${body}`);
  return { id, title };
}

async function writePage(
  vault: string,
  topic: string,
  url: string,
): Promise<{ id: string; title: string }> {
  const folder = resolve(vault, topic);
  const title = `Página ${new URL(url).pathname.replace(/\//g, ' ').trim() || 'inicial'}`;
  const id = `raw/articles/${slugOf(url)}.md`;
  const page = `---\ntitle: "${title}"\ntype: source\nsource_path: "${url}"\nconverter: firecrawl\n---\n\n# ${title}\n\nTexto da página.\n`;
  await put(folder, resolve(folder, id), page);
  return { id, title };
}

/** `kb topic new`, as the Mac runs it for a collection made on the screen (KBC-009 R2). */
async function makeTopic(
  vault: string,
  topic: { slug: string; title: string },
): Promise<void> {
  const folder = resolve(vault, topic.slug);
  const file = resolve(folder, 'topic.yaml');
  if (await readFile(file).catch(() => null)) return;
  const yaml = `slug: ${topic.slug}\ntitle: "${topic.title}"\ndomain: geral\nmode: wiki\n`;
  await put(folder, file, yaml);
}

async function put(folder: string, file: string, data: string | Buffer) {
  if (!file.startsWith(folder + sep)) throw new Error(`unsafe ${file}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
}
