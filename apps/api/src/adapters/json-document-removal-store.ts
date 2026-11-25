import { z } from 'zod';
import type {
  RemovalRecord,
  RemovalStorePort,
} from '../ports/document-removals.js';
import { readJsonFile, writeJsonFile } from './atomic-json.js';

const wishSchema = z.enum(['removed', 'present']);

const recordSchema = z.object({
  id: z.uuid(),
  topic: z.string(),
  document: z.object({ id: z.string(), title: z.string() }),
  level: z.string().nullable(),
  by: z.object({ email: z.string(), name: z.string() }),
  removedAt: z.string(),
  wish: wishSchema,
  isQuarantined: z.boolean().nullable(),
  lease: z
    .object({
      leaseId: z.string(),
      worker: z.string(),
      until: z.string(),
      wish: wishSchema,
    })
    .nullable(),
  attempts: z.number(),
  failed: z.boolean(),
  detail: z.string().nullable(),
});

const fileSchema = z.object({
  version: z.literal(1),
  removals: z.array(recordSchema),
});

/** `document-removals.json` in the state directory: atomic, owner-only. */
export class JsonDocumentRemovalStore implements RemovalStorePort {
  constructor(private readonly file: string) {}

  async load(): Promise<readonly RemovalRecord[]> {
    const raw = await readJsonFile(this.file);
    return raw === null ? [] : fileSchema.parse(raw).removals;
  }

  async save(records: readonly RemovalRecord[]): Promise<void> {
    await writeJsonFile(this.file, { version: 1, removals: records });
  }
}

/** For tests and the E2E server: the records in memory. */
export class MemoryDocumentRemovalStore implements RemovalStorePort {
  records: readonly RemovalRecord[] = [];

  load(): Promise<readonly RemovalRecord[]> {
    return Promise.resolve(this.records);
  }

  save(records: readonly RemovalRecord[]): Promise<void> {
    this.records = records;
    return Promise.resolve();
  }
}
