import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat, statfs, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DocumentUploadFilesPort } from '../ports/document-uploads.js';
import { UploadRefusedError } from '../ports/media-files.js';

/** A part silent this long is cut: a dead socket must not hold the upload (as media). */
const PART_IDLE_MS = 30_000;
const SAFE_ID = /^[0-9a-f-]{36}$/;

class ByteLimit extends Transform {
  constructor(private left: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: string,
    done: TransformCallback,
  ): void {
    this.left -= chunk.length;
    if (this.left < 0) done(new UploadRefusedError('too-large'));
    else done(null, chunk);
  }
}

/** Sent documents under one folder of the state directory (KBC-149, ADR 0040). */
export class FsDocumentUploadFiles implements DocumentUploadFilesPort {
  constructor(
    private readonly root: string,
    private readonly partIdleMs = PART_IDLE_MS,
  ) {}

  private pathOf(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error('not an upload id');
    return join(this.root, `${id}.upload`);
  }

  async offset(id: string): Promise<number> {
    return (await this.find(id))?.size ?? 0;
  }

  async append(id: string, body: Readable, maxBytes: number): Promise<number> {
    const before = await this.offset(id);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const limit = new ByteLimit(maxBytes - before);
    const silence = this.watch(body, limit);
    const written = pipeline(
      limit,
      createWriteStream(this.pathOf(id), { flags: 'a', mode: 0o600 }),
    );
    body.pipe(limit);
    try {
      await written;
    } catch (err) {
      if (!(err instanceof UploadRefusedError)) throw err;
      if (err.problem === 'too-large') {
        await truncate(this.pathOf(id), before);
        throw err;
      }
    } finally {
      clearTimeout(silence);
    }
    return this.offset(id);
  }

  /** A silent part is cut; the rest of a refused one is drained, so the answer gets out. */
  private watch(body: Readable, limit: ByteLimit): NodeJS.Timeout {
    const silence = setTimeout(
      () => limit.destroy(new UploadRefusedError('incomplete')),
      this.partIdleMs,
    );
    limit.on('data', () => silence.refresh());
    body.once('error', (err) => limit.destroy(err));
    limit.once('error', () => {
      body.unpipe(limit);
      body.resume();
    });
    return silence;
  }

  async sha256(id: string): Promise<string> {
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(this.pathOf(id)))
      hash.update(chunk as Buffer);
    return hash.digest('hex');
  }

  async freeBytes(): Promise<number> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const disk = await statfs(this.root);
    return disk.bavail * disk.bsize;
  }

  async find(id: string): Promise<{ path: string; size: number } | null> {
    try {
      const info = await stat(this.pathOf(id));
      return info.isFile() ? { path: this.pathOf(id), size: info.size } : null;
    } catch {
      return null;
    }
  }

  async remove(id: string): Promise<void> {
    await rm(this.pathOf(id), { force: true });
  }
}
