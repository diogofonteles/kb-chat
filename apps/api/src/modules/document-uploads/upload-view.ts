import type {
  DocumentBatch,
  DocumentProgress,
  DocumentUpload,
} from '@kb-chat/contracts';
import type { DocumentUploadRecord } from '../../ports/document-uploads.js';
import type { PlaceInLine } from './mac-line.js';
import { WORKING_STATES, isWorking } from './upload-batches.js';

/** Where a recording link's media item is now (it goes through the library, KBC-142 BR-5). */
export interface MediaProgress {
  readonly state: 'transcribing' | 'ready' | 'failed';
  /** Where it is while `transcribing`. */
  readonly step: NonNullable<DocumentProgress['media']> | null;
}

export const uploadUrlOf = (id: string): string =>
  `/api/v1/document-uploads/${id}/upload`;

/** What the view needs besides the record itself. */
export interface UploadContext {
  readonly showsDetail: boolean;
  readonly received: number | null;
  readonly media: MediaProgress | null;
  readonly place: PlaceInLine;
  readonly now: Date;
  /** The document it became is in the app's catalog now (search, map): "pronto". */
  readonly arrived: boolean;
  readonly batch: DocumentBatch | null;
  /** The spending ceiling that makes it wait, if any (KBC-009 R3). */
  readonly heldBy: DocumentUpload['heldBy'];
  /** Only its sender sends its bytes. */
  readonly mine: boolean;
  /** A link, or a file whose bytes are still here: it can go again. */
  readonly kept: boolean;
}

/** The contract's view: the Mac's words only for masters (they may name paths and keys). */
export function toDocumentUpload(
  record: DocumentUploadRecord,
  input: UploadContext,
): DocumentUpload {
  const media = mediaOf(record, input.media);
  const state = media?.state ?? stateOf(record, input);
  return {
    id: record.id,
    topic: record.topic,
    kind: record.kind,
    name: record.name,
    state,
    failure: media?.state === 'failed' ? 'conversion-failed' : record.failure,
    detail: input.showsDetail ? record.detail : null,
    document: record.document,
    mediaId: record.mediaId,
    bytes: record.bytes,
    received: record.kind === 'file' ? input.received : null,
    uploadUrl: sendsTo(record, input.mine),
    batch: input.batch,
    heldBy: state === 'received' ? input.heldBy : null,
    review: record.review,
    entryCount: entryCountOf(record),
    mine: input.mine,
    retriable: state === 'failed' && input.kept,
    progress: { ...input.place, media: media?.step ?? null },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

const entryCountOf = ({ state, entries }: DocumentUploadRecord): number =>
  state === 'choosing' ? entries.length : 0;

const sendsTo = (record: DocumentUploadRecord, mine: boolean) =>
  record.state === 'receiving' && mine ? uploadUrlOf(record.id) : null;

const mediaOf = (
  record: DocumentUploadRecord,
  media: MediaProgress | null,
): MediaProgress | null =>
  record.kind === 'recording' && record.mediaId && media ? media : null;

/**
 * Done on the Mac is "no mapa" until the sync brings it to the catalog: then "pronto". One the
 * Mac dropped (its lease ran out) waits again.
 */
function stateOf(
  record: DocumentUploadRecord,
  { arrived, now }: Pick<UploadContext, 'arrived' | 'now'>,
): DocumentUpload['state'] {
  if (record.state === 'mapped' && arrived) return 'ready';
  const dropped = WORKING_STATES.has(record.state) && !isWorking(record, now);
  return dropped ? 'received' : record.state;
}
