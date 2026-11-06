import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import type {
  CompleteKbPublishRequest,
  KbPublishJob,
} from '@kb-chat/contracts';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createMediaDocuments } from '../media-documents-factory.js';
import type { MediaDeps } from '../media-factory.js';
import type { AuthorsService } from '../modules/authors/index.js';
import { PUBLIC } from '../modules/auth/index.js';
import type { CatalogRegistry } from '../modules/catalog/index.js';

const WORKER = 'transcriber:e2e-mac';

/** What the fake kb writes into every document it "classifies": fixed, no model. */
const FAKE_KB_FACETS = [
  'genre: talk_or_interview',
  'depth: 2',
  'relevance: core',
  'summary: Faixa publicada pelo Mac de teste.',
].join('\n');

/** Writes one job's documents into the vault, as the Mac does, with the fake kb's facets. */
async function writeDocuments(vault: string, job: KbPublishJob): Promise<void> {
  const folder = resolve(vault, job.topic);
  for (const item of job.items) {
    const file = resolve(folder, item.path);
    if (!file.startsWith(folder + sep)) throw new Error(`unsafe ${item.path}`);
    await mkdir(dirname(file), { recursive: true });
    const classified = item.markdown.replace(
      /^---\n/,
      `---\n${FAKE_KB_FACETS}\n`,
    );
    await writeFile(file, classified, 'utf8');
  }
}

const resultOf = (job: KbPublishJob): CompleteKbPublishRequest => ({
  worker: WORKER,
  leaseId: job.leaseId,
  documents: job.items.map((item) => ({
    path: item.path,
    ok: true,
    facets: { genre: 'talk_or_interview', depth: 2 },
    spendUsd: 0,
  })),
});

/**
 * The E2E server only (KBC-099): plays the owner's Mac marked "Publica no acervo" with a
 * fake kb. It leases every waiting kb-publish job through the real queue, writes the
 * documents into the E2E vault (a temporary copy), reports the result and reads the
 * collection again, as the production catalog does after a sync. No transcriber is paired,
 * so no other spec sees one turn "on"; no kb binary and no model run.
 */
export function registerKbPublishMac(
  app: FastifyInstance,
  input: {
    media: MediaDeps;
    catalog: CatalogRegistry;
    authors: AuthorsService;
    vault: string;
  },
): void {
  const { kb } = createMediaDocuments(input);
  const topicBody = z.object({ topic: z.string().min(1) });
  app.post(
    '/api/e2e/kb-publish/run',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      // Only the asking spec's collection: other specs' tracks stay in the queue.
      const { topic } = topicBody.parse(request.body);
      const documents = await publishAll(kb, { topic, vault: input.vault });
      await input.catalog.refresh(topic);
      return reply.code(200).send({ documents });
    },
  );
}

/** Every waiting job of the collection, written and reported; how many documents. */
async function publishAll(
  kb: ReturnType<typeof createMediaDocuments>['kb'],
  { topic, vault }: { topic: string; vault: string },
): Promise<number> {
  let documents = 0;
  for (let job = kb.lease(WORKER, topic); job; job = kb.lease(WORKER, topic)) {
    await writeDocuments(vault, job);
    kb.complete(
      { jobId: job.id, worker: WORKER, leaseId: job.leaseId },
      resultOf(job),
    );
    documents += job.items.length;
  }
  return documents;
}
