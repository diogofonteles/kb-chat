import { z } from 'zod';
import {
  DOCUMENT_UPLOAD_FAILURES,
  DOCUMENT_UPLOAD_STATES,
} from '@kb-chat/contracts';
import type {
  DocumentUploadRecord,
  DocumentUploadStorePort,
} from '../ports/document-uploads.js';
import { readJsonFile, writeJsonFile } from './atomic-json.js';

const recordSchema = z.object({
  id: z.uuid(),
  topic: z.string(),
  kind: z.enum(['file', 'url', 'youtube']),
  name: z.string(),
  url: z.string().nullable(),
  sha256: z.string().nullable(),
  bytes: z.number().nullable(),
  level: z.string().nullable(),
  owner: z.object({
    principal: z.string(),
    email: z.string(),
    isMaster: z.boolean(),
    quotaBytes: z.number().nullable(),
    displayName: z.string().nullable(),
  }),
  state: z.enum(DOCUMENT_UPLOAD_STATES),
  failure: z.enum(DOCUMENT_UPLOAD_FAILURES).nullable(),
  detail: z.string().nullable(),
  document: z.object({ id: z.string(), title: z.string() }).nullable(),
  mediaId: z.string().nullable(),
  lease: z
    .object({ leaseId: z.string(), worker: z.string(), until: z.string() })
    .nullable(),
  attempts: z.number(),
  spentUsd: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const fileSchema = z.object({
  version: z.literal(1),
  uploads: z.array(recordSchema),
});

/** `document-uploads.json` in the state directory: atomic, owner-only (like collections.json). */
export class JsonDocumentUploadStore implements DocumentUploadStorePort {
  constructor(private readonly file: string) {}

  async load(): Promise<readonly DocumentUploadRecord[]> {
    const raw = await readJsonFile(this.file);
    return raw === null ? [] : fileSchema.parse(raw).uploads;
  }

  async save(records: readonly DocumentUploadRecord[]): Promise<void> {
    await writeJsonFile(this.file, { version: 1, uploads: records });
  }
}

/** For tests and the E2E server: the records in memory. */
export class MemoryDocumentUploadStore implements DocumentUploadStorePort {
  records: readonly DocumentUploadRecord[] = [];

  load(): Promise<readonly DocumentUploadRecord[]> {
    return Promise.resolve(this.records);
  }

  save(records: readonly DocumentUploadRecord[]): Promise<void> {
    this.records = records;
    return Promise.resolve();
  }
}
