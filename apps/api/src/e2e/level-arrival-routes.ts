import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PUBLIC } from '../modules/auth/index.js';
import type { CatalogRegistry } from '../modules/catalog/index.js';

const arrivalBody = z.object({
  topic: z.string().min(1),
  /** Each new document: its file name, title and whether kb transcribed it from an audio. */
  docs: z
    .array(
      z.object({
        name: z.string().regex(/^[a-z0-9-]+$/),
        title: z.string().min(1),
        audio: z.boolean().default(false),
      }),
    )
    .min(1)
    .max(50),
});

/**
 * KBC-107 (E2E only): documents that arrive from kb on the Mac, written into the E2E vault,
 * then the reload a sync makes, so "Sem nível" has something to show.
 */
export function registerLevelArrivals(
  app: FastifyInstance,
  input: { readonly vault: string; readonly catalog: CatalogRegistry },
): void {
  app.post(
    '/api/e2e/levels/arrive',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { topic, docs } = arrivalBody.parse(request.body);
      const folder = resolve(input.vault, topic, 'raw');
      if (!folder.startsWith(resolve(input.vault) + sep))
        throw new Error(`unsafe ${topic}`);
      await mkdir(folder, { recursive: true });
      for (const doc of docs) {
        const source = doc.audio ? `\nsource_path: audio/${doc.name}.mp3` : '';
        await writeFile(
          join(folder, `${doc.name}.md`),
          `---\ntitle: ${doc.title}\ngenre: reference_docs\ndepth: 1\nrelevance: collected_on_purpose${source}\n---\n\nChegou do kb.\n`,
        );
      }
      await input.catalog.load();
      return reply.code(204).send();
    },
  );
}
