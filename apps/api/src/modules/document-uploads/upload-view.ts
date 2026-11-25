import type { DocumentBatch, DocumentUpload } from '@kb-chat/contracts';
import type { DocumentUploadRecord } from '../../ports/document-uploads.js';

/** Where a YouTube link's media item is now (it goes through the library, KBC-142 BR-5). */
export type MediaProgress = 'transcribing' | 'ready' | 'failed';

export const uploadUrlOf = (id: string): string =>
  `/api/v1/document-uploads/${id}/upload`;

/** What the view needs besides the record itself. */
export interface UploadContext {
  readonly showsDetail: boolean;
  readonly received: number | null;
  readonly media: MediaProgress | null;
  /** The document it became is in the app's catalog now (search, map): "pronto". */
  readonly arrived: boolean;
  readonly batch: DocumentBatch | null;
  /** The spending ceiling that makes it wait, if any (KBC-009 R3). */
  readonly heldBy: DocumentUpload['heldBy'];
  /** A link, or a file whose bytes are still here: it can go again. */
  readonly kept: boolean;
}

/** The contract's view: the Mac's words only for masters (they may name paths and keys). */
export function toDocumentUpload(
  record: DocumentUploadRecord,
  input: UploadContext,
): DocumentUpload {
  const fromMedia = mediaStateOf(record, input.media);
  return {
    id: record.id,
    topic: record.topic,
    kind: record.kind,
    name: record.name,
    state: fromMedia ?? stateOf(record, input.arrived),
    failure: fromMedia === 'failed' ? 'conversion-failed' : record.failure,
    detail: input.showsDetail ? record.detail : null,
    document: record.document,
    mediaId: record.mediaId,
    bytes: record.bytes,
    received: record.kind === 'file' ? input.received : null,
    uploadUrl: record.state === 'receiving' ? uploadUrlOf(record.id) : null,
    batch: input.batch,
    heldBy: record.state === 'received' ? input.heldBy : null,
    retriable: record.state === 'failed' && input.kept,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const mediaStateOf = (
  record: DocumentUploadRecord,
  media: MediaProgress | null,
): MediaProgress | null =>
  record.kind === 'youtube' && record.mediaId && media ? media : null;

/** Done on the Mac is "no mapa" until the sync brings it to the catalog: then "pronto". */
const stateOf = (record: DocumentUploadRecord, arrived: boolean) =>
  record.state === 'mapped' && arrived ? 'ready' : record.state;
