import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import { AppError } from '../../app-error.js';
import {
  SampleIndexCache,
  hiddenTagOf,
  insideHidden,
  maskPlanOf,
  maskedStream,
  readAtOf,
  type MaskPlan,
} from './masked-stream.js';
import type { PlayableFile } from './media-service.js';
import { entityTagOf, parseRange, rangeStillValid } from './range.js';

export interface RangeOpener {
  openRange(path: string, range: { start: number; end: number }): Readable;
}

/** Sample tables of the files played lately, for the masked streams (KBC-106). */
const indexes = new SampleIndexCache();

/**
 * Sends a media file with HTTP Range (ADR 0022 §5): 206 with `Content-Range` for a range,
 * 200 for the whole file, 416 for a range past the end. The file is streamed from disk,
 * never read whole; `If-Range` with an old tag gets the whole (new) file. With hidden parts
 * (KBC-106 FR-2) their frames go out silent, and a range wholly inside one is 416.
 */
export async function serveMedia(context: {
  readonly id: string;
  readonly file: PlayableFile;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly open: RangeOpener;
}) {
  const { id, file, request, reply, open } = context;
  const plan = await maskOf(file, open);
  const etag = tagOf(id, file, plan);
  setFileHeaders(reply, { file, etag });
  const answer = parseRange(requestedRange(request, etag), file.size);
  if (
    answer.kind === 'unsatisfiable' ||
    (answer.kind === 'partial' && plan && insideHidden(plan, answer))
  )
    return unsatisfiable(reply, file.size);
  const { start, end } =
    answer.kind === 'partial' ? answer : { start: 0, end: file.size - 1 };
  if (answer.kind === 'partial')
    reply
      .code(206)
      .header('content-range', `bytes ${start}-${end}/${file.size}`);
  const body = open.openRange(file.path, { start, end });
  return reply
    .header('content-length', String(end - start + 1))
    .send(plan ? maskedStream(body, plan, start) : body);
}

/** A masked file is another entity than the whole one: its tag names the hidden set. */
const tagOf = (id: string, file: PlayableFile, plan: MaskPlan | null) =>
  plan
    ? entityTagOf(id, file).replace(
        /"$/,
        `-h${hiddenTagOf(file.hidden ?? [])}"`,
      )
    : entityTagOf(id, file);

const unsatisfiable = (reply: FastifyReply, size: number) =>
  reply.code(416).header('content-range', `bytes */${size}`).send();

/** What to silence for this person; null when nothing is hidden. Unreadable: closed. */
async function maskOf(
  file: PlayableFile,
  open: RangeOpener,
): Promise<MaskPlan | null> {
  const hidden = file.hidden ?? [];
  if (hidden.length === 0) return null;
  const index = await indexes.indexOf(
    file,
    readAtOf((range) => open.openRange(file.path, range), file.size),
  );
  // Without its sample table nothing can be kept from this person: nothing is sent.
  if (!index)
    throw new AppError('MEDIA_NOT_READY', 'This media cannot be played yet');
  return maskPlanOf(index, hidden);
}

function setFileHeaders(
  reply: FastifyReply,
  { file, etag }: { file: PlayableFile; etag: string },
): void {
  reply
    .header('accept-ranges', 'bytes')
    .header('etag', etag)
    .header('last-modified', new Date(file.modifiedMs).toUTCString())
    .header('cache-control', 'private, no-cache')
    .header('content-type', file.mime);
}

/** The Range header, unless If-Range names an older version of the file. */
const requestedRange = (request: FastifyRequest, etag: string) =>
  rangeStillValid(headerOf(request, 'if-range'), etag)
    ? headerOf(request, 'range')
    : undefined;

const headerOf = (
  request: FastifyRequest,
  name: string,
): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};
