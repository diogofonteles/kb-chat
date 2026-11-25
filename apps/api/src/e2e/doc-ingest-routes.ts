import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type { DocIngestJob } from '@kb-chat/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PUBLIC } from '../modules/auth/index.js';
import type { CatalogRegistry } from '../modules/catalog/index.js';
import type { DocIngestQueue } from '../modules/document-uploads/index.js';

const WORKER = 'transcriber:e2e-mac';
/** A link whose host says so does not convert (KBC-149 AC-4). */
const BROKEN_HOST = /quebrado/;

const topicBody = z.object({ topic: z.string().min(1) });

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
    queue: () => DocIngestQueue | null;
    vault: string;
    catalog: CatalogRegistry;
  },
): void {
  app.post(
    '/api/e2e/doc-ingest/run',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { topic } = topicBody.parse(request.body);
      const queue = input.queue();
      if (!queue) return reply.code(404).send();
      let done = 0;
      for (
        let job = queue.lease(WORKER, topic);
        job;
        job = queue.lease(WORKER, topic)
      ) {
        await ingest(queue, { job, vault: input.vault });
        done += 1;
      }
      await input.catalog.refresh(topic);
      return reply.code(200).send({ done });
    },
  );
}

async function ingest(
  queue: DocIngestQueue,
  input: { job: DocIngestJob; vault: string },
): Promise<void> {
  const { job, vault } = input;
  const owner = { jobId: job.id, worker: WORKER, leaseId: job.leaseId };
  const { source } = job;
  if (source.kind !== 'file' && BROKEN_HOST.test(source.url)) {
    await queue.complete(owner, {
      ...owner,
      outcome: {
        state: 'failed',
        failure: 'conversion-failed',
        detail: 'firecrawl: HTTP 404; jina: HTTP 404',
      },
      spendUsd: 0,
    });
    return;
  }
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

/** What kb-map convert would leave in the vault for the job's file or link. */
async function converted(
  queue: DocIngestQueue,
  { job, vault }: { job: DocIngestJob; vault: string },
): Promise<{ id: string; title: string }> {
  const { source } = job;
  if (source.kind !== 'file') return writePage(vault, job.topic, source.url);
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
