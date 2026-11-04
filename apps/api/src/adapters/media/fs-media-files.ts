import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  constants,
  mkdir,
  rename,
  rm,
  stat,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  UploadRefusedError,
  type MediaFilesPort,
  type StoredFile,
} from '../../ports/media-files.js';

const UPLOADS = 'uploads';
const AUDIO = 'audio';
const TRANSCRIPTS = 'transcripts';

/** Counts the bytes going through and stops the stream as soon as they pass the limit. */
class ByteLimit extends Transform {
  private seen = 0;

  constructor(private readonly limit: number) {
    super();
  }

  get bytes(): number {
    return this.seen;
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    done: TransformCallback,
  ): void {
    this.seen += chunk.length;
    if (this.seen > this.limit) done(new UploadRefusedError('too-large'));
    else done(null, chunk);
  }
}

/** Media files under one directory, mounted at /data/media in production (ADR 0022). */
export class FsMediaFiles implements MediaFilesPort {
  constructor(private readonly root: string) {}

  uploadPath(mediaId: string): string {
    return `${UPLOADS}/${mediaId}.upload`;
  }

  audioPath(mediaId: string): string {
    return `${AUDIO}/${mediaId}.m4a`;
  }

  workPath(mediaId: string, leaseId: string): string {
    return `${AUDIO}/${mediaId}.${leaseId}.work.m4a`;
  }

  trackPath(mediaId: string, leaseId: string): string {
    return `${AUDIO}/${mediaId}.${leaseId}.m4a`;
  }

  flacPath(mediaId: string): string {
    return `${AUDIO}/${mediaId}.flac`;
  }

  flacWorkPath(mediaId: string, leaseId: string): string {
    return `${AUDIO}/${mediaId}.${leaseId}.work.flac`;
  }

  transcriptPath(mediaId: string, transcriptId: string): string {
    return `${TRANSCRIPTS}/${mediaId}/${transcriptId}.json`;
  }

  diarizationPath(mediaId: string, diarizationId: string): string {
    return `${TRANSCRIPTS}/${mediaId}/diarization-${diarizationId}.json`;
  }

  async writeFile(path: string, data: string): Promise<void> {
    const target = this.resolve(path);
    const temp = `${target}.${randomUUID()}.tmp`;
    await mkdir(dirname(target), { recursive: true });
    try {
      await writeFile(temp, data, { flag: 'wx' });
      await rename(temp, target);
    } catch (err) {
      await rm(temp, { force: true });
      throw err;
    }
  }

  async removeTranscripts(mediaId: string): Promise<void> {
    await rm(this.resolve(`${TRANSCRIPTS}/${mediaId}`), {
      recursive: true,
      force: true,
    });
  }

  async promote(from: string, to: string): Promise<void> {
    await rename(this.resolve(from), this.resolve(to));
  }

  async saveUpload(input: {
    mediaId: string;
    body: Readable;
    expectedBytes: number;
  }): Promise<void> {
    const target = this.resolve(this.uploadPath(input.mediaId));
    const partial = `${target}.part`;
    await mkdir(this.resolve(UPLOADS), { recursive: true });
    const limit = new ByteLimit(input.expectedBytes);
    try {
      await this.writeLimited(input.body, { limit, path: partial, flags: 'w' });
      if (limit.bytes !== input.expectedBytes)
        throw new UploadRefusedError('incomplete');
      await rename(partial, target);
    } catch (err) {
      await rm(partial, { force: true });
      throw err;
    }
  }

  /**
   * Streams the body through the byte limit into the file. The body is never destroyed:
   * on a refusal the rest is drained, so the API can still answer 413 on the connection;
   * a body that closes before its end (the client gave up) counts as incomplete.
   */
  private async writeLimited(
    body: Readable,
    target: { limit: ByteLimit; path: string; flags: 'w' | 'a' },
  ): Promise<void> {
    const { limit } = target;
    const written = pipeline(
      limit,
      createWriteStream(target.path, { flags: target.flags }),
    );
    const detach = () => {
      body.unpipe(limit);
      body.resume();
    };
    body.once('error', (err) => limit.destroy(err));
    body.once('close', () => {
      if (!body.readableEnded)
        limit.destroy(new UploadRefusedError('incomplete'));
    });
    limit.once('error', detach);
    body.pipe(limit);
    await written;
  }

  async uploadOffset(mediaId: string): Promise<number> {
    const part = await this.stat(`${this.uploadPath(mediaId)}.part`);
    return part?.size ?? 0;
  }

  async appendUpload(input: {
    mediaId: string;
    body: Readable;
    expectedBytes: number;
  }): Promise<number> {
    const offset = await this.uploadOffset(input.mediaId);
    const path = `${this.resolve(this.uploadPath(input.mediaId))}.part`;
    await mkdir(this.resolve(UPLOADS), { recursive: true });
    const limit = new ByteLimit(input.expectedBytes - offset);
    try {
      await this.writeLimited(input.body, { limit, path, flags: 'a' });
    } catch (err) {
      if (!(err instanceof UploadRefusedError)) throw err;
      if (err.problem === 'too-large') {
        await truncate(path, offset);
        throw err;
      }
    }
    return this.uploadOffset(input.mediaId);
  }

  async hashUpload(mediaId: string): Promise<string> {
    const hash = createHash('sha256');
    const path = `${this.resolve(this.uploadPath(mediaId))}.part`;
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  async finishUpload(mediaId: string): Promise<void> {
    const target = this.resolve(this.uploadPath(mediaId));
    await rename(`${target}.part`, target);
  }

  async discardUpload(mediaId: string): Promise<void> {
    const upload = this.resolve(this.uploadPath(mediaId));
    await Promise.all([
      rm(upload, { force: true }),
      rm(`${upload}.part`, { force: true }),
    ]);
  }

  async stat(path: string): Promise<StoredFile | null> {
    try {
      const info = await stat(this.resolve(path));
      return info.isFile()
        ? { size: info.size, modifiedMs: info.mtimeMs }
        : null;
    } catch {
      return null;
    }
  }

  read(path: string, range: { start: number; end: number }): Readable {
    return createReadStream(this.resolve(path), range);
  }

  async remove(paths: readonly string[]): Promise<void> {
    await Promise.all(
      paths.map((path) => rm(this.resolve(path), { force: true })),
    );
  }

  async assertWritable(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await access(this.root, constants.W_OK);
    await mkdir(this.resolve(UPLOADS), { recursive: true });
    await mkdir(this.resolve(AUDIO), { recursive: true });
  }

  /** The absolute path of a relative one, refusing anything that leaves the root. */
  private resolve(path: string): string {
    const relative = normalize(path);
    if (isAbsolute(relative) || relative.split(sep).includes('..'))
      throw new Error(`media path outside the media directory: ${path}`);
    return join(this.root, relative);
  }
}
