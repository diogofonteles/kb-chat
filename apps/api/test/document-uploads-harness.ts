/**
 * Documents and links sent from the app (KBC-149, ADR 0040), driven through the real routes:
 * a person sends, a transcriber marked "Publica no acervo" leases doc-ingest jobs, and a fake
 * Mac plays kb-map convert and kb (writes the document into the test's vault copy).
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CreateDocumentUploadResponse,
  DocIngestJob,
  DocumentUpload,
} from '@kb-chat/contracts';
import { expect } from 'vitest';
import { LOCAL, type Call } from './ai-app-harness.js';
import { leaseAs, publisherMac } from './kb-publish-harness.js';
import type { Media } from './media-harness.js';
import { asTranscriber } from './transcription-harness.js';

export const PDF = Buffer.from('%PDF-1.4 tres capitulos e uma tabela');
export const PDF_SHA = createHash('sha256').update(PDF).digest('hex');
export const DOCUMENTS = '/api/v1/topics/hermetismo/documents';
export const UPLOADS = '/api/v1/document-uploads';

export const announce = (call: Call, fields: object = {}) =>
  call('POST', DOCUMENTS, {
    kind: 'file',
    name: 'O Caibalion.pdf',
    bytes: PDF.length,
    sha256: PDF_SHA,
    ...fields,
  });

/** A tus PATCH of `body` at `offset`, as the person with `headers`. */
export const sendPart = (
  media: Media,
  input: {
    id: string;
    body: Buffer;
    offset: number;
    headers: Record<string, string>;
  },
) =>
  media.started.app.inject({
    method: 'PATCH',
    url: `${UPLOADS}/${input.id}/upload`,
    headers: {
      ...input.headers,
      'content-type': 'application/offset+octet-stream',
      'upload-offset': String(input.offset),
      'tus-resumable': '1.0.0',
    },
    payload: input.body,
  });

/** A file announced and every byte sent: received, waiting for the Mac. */
export async function sentFile(
  media: Media,
  person: { call: Call; headers: Record<string, string> },
  fields: object = {},
): Promise<DocumentUpload> {
  const created = await announce(person.call, fields);
  expect(created.statusCode, created.body).toBe(201);
  const answer = created.json<CreateDocumentUploadResponse>();
  if (answer.outcome !== 'created') throw new Error('expected a new upload');
  const sent = await sendPart(media, {
    id: answer.upload.id,
    body: PDF,
    offset: 0,
    headers: person.headers,
  });
  expect(sent.statusCode, sent.body).toBe(204);
  expect(sent.headers['upload-offset']).toBe(String(PDF.length));
  return answer.upload;
}

export async function docMac(media: Media) {
  return publisherMac(media, ['transcribe', 'kb-publish']);
}

export async function leaseDoc(
  media: Media,
  token: string,
): Promise<DocIngestJob> {
  const leased = await leaseAs(media, token, ['doc-ingest']);
  expect(leased.statusCode, leased.body).toBe(200);
  const job = leased.json<DocIngestJob>();
  expect(job.kind).toBe('doc-ingest');
  return job;
}

export const asMac = (
  media: Media,
  token: string,
  request: { method: 'GET' | 'POST'; url: string; payload?: object },
) => asTranscriber(media, token, request);

export const docState = (
  media: Media,
  input: { token: string; job: DocIngestJob; state: string },
) =>
  asMac(media, input.token, {
    method: 'POST',
    url: `/api/v1/media-worker/jobs/${input.job.id}/doc-state`,
    payload: { worker: 'mac', leaseId: input.job.leaseId, state: input.state },
  });

export const docResult = (
  media: Media,
  input: {
    token: string;
    job: DocIngestJob;
    outcome: object;
    spendUsd?: number;
  },
) =>
  asMac(media, input.token, {
    method: 'POST',
    url: `/api/v1/media-worker/jobs/${input.job.id}/doc-result`,
    payload: {
      worker: 'mac',
      leaseId: input.job.leaseId,
      outcome: input.outcome,
      spendUsd: input.spendUsd ?? 0,
    },
  });

/** What the Mac's kb-map convert leaves in the vault: the document with its provenance. */
export async function writeConverted(
  media: Media,
  input: {
    vault: string;
    id: string;
    title: string;
    sha256?: string;
    url?: string;
  },
): Promise<void> {
  const path = join(input.vault, 'hermetismo', input.id);
  await mkdir(dirname(path), { recursive: true });
  const provenance = input.sha256
    ? `original_sha256: ${input.sha256}\noriginal_name: "O Caibalion.pdf"\nconverter: docling\n`
    : '';
  const source = input.url ? `source_path: "${input.url}"\n` : '';
  await writeFile(
    path,
    `---\ntitle: ${input.title}\ntype: source\n${provenance}${source}---\n\n# Capítulo 1\n\nO todo é mente.\n`,
  );
  await media.started.catalog.refresh('hermetismo');
}

export const uploadsOf = async (call: Call): Promise<DocumentUpload[]> => {
  const listed = await call('GET', UPLOADS);
  expect(listed.statusCode, listed.body).toBe(200);
  return listed.json<{ items: DocumentUpload[] }>().items;
};

export const localHeaders = (token: string) => ({
  ...LOCAL,
  authorization: `Bearer ${token}`,
});
