import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Readable } from 'node:stream';
import type { PlayableFile } from './media-service.js';
import { entityTagOf, parseRange, rangeStillValid } from './range.js';

export interface RangeOpener {
  openRange(path: string, range: { start: number; end: number }): Readable;
}

/**
 * Sends a media file with HTTP Range (ADR 0022 §5): 206 with `Content-Range` for a range,
 * 200 for the whole file, 416 for a range past the end. The file is streamed from disk,
 * never read whole; `If-Range` with an old tag gets the whole (new) file.
 */
export function serveMedia(context: {
  readonly id: string;
  readonly file: PlayableFile;
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly open: RangeOpener;
}) {
  const { id, file, request, reply, open } = context;
  const etag = entityTagOf(id, file);
  setFileHeaders(reply, { file, etag });
  const answer = parseRange(requestedRange(request, etag), file.size);
  if (answer.kind === 'unsatisfiable')
    return reply
      .code(416)
      .header('content-range', `bytes */${file.size}`)
      .send();
  const { start, end } =
    answer.kind === 'partial' ? answer : { start: 0, end: file.size - 1 };
  if (answer.kind === 'partial')
    reply
      .code(206)
      .header('content-range', `bytes ${start}-${end}/${file.size}`);
  return reply
    .header('content-length', String(end - start + 1))
    .send(open.openRange(file.path, { start, end }));
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
