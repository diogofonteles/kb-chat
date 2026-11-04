import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { text } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UploadRefusedError } from '../../ports/media-files.js';
import { FsMediaFiles } from './fs-media-files.js';

const ID = '11111111-1111-4111-8111-111111111111';
let root: string;
let files: FsMediaFiles;

const chunks = (...parts: string[]) =>
  Readable.from(parts.map((p) => Buffer.from(p)));

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'kbchat-media-files-'));
  files = new FsMediaFiles(root);
  await files.assertWritable();
});
afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe('FsMediaFiles: a resumable upload (KBC-035)', () => {
  it('appends parts and appears for the worker only when finished', async () => {
    const append = (part: string) =>
      files.appendUpload({ mediaId: ID, body: chunks(part), expectedBytes: 6 });
    expect(await files.uploadOffset(ID)).toBe(0);
    expect(await append('abc')).toBe(3);
    expect(await append('def')).toBe(6);
    expect(await files.stat(files.uploadPath(ID))).toBeNull();
    await files.finishUpload(ID);
    expect(
      await text(files.read(files.uploadPath(ID), { start: 0, end: 5 })),
    ).toBe('abcdef');
  });

  it('keeps what arrived of a part cut short (NFR-1)', async () => {
    const cut = new PassThrough();
    const appending = files.appendUpload({
      mediaId: ID,
      body: cut,
      expectedBytes: 100,
    });
    cut.write(Buffer.from('abcde'));
    await vi.waitFor(() =>
      expect(existsSync(join(root, 'uploads', `${ID}.upload.part`))).toBe(true),
    );
    await new Promise((resolve) => setImmediate(resolve));
    cut.destroy();
    expect(await appending).toBe(5);
    expect(await files.uploadOffset(ID)).toBe(5);
  });

  it('refuses a part past the announced size and stays where it was', async () => {
    await files.appendUpload({
      mediaId: ID,
      body: chunks('abc'),
      expectedBytes: 6,
    });
    await expect(
      files.appendUpload({
        mediaId: ID,
        body: chunks('defg'),
        expectedBytes: 6,
      }),
    ).rejects.toBeInstanceOf(UploadRefusedError);
    expect(await files.uploadOffset(ID)).toBe(3);
  });

  it('hashes what it has', async () => {
    await files.appendUpload({
      mediaId: ID,
      body: chunks('abc'),
      expectedBytes: 3,
    });
    expect(await files.hashUpload(ID)).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('FsMediaFiles', () => {
  it('saves an upload of exactly the announced size', async () => {
    await files.saveUpload({
      mediaId: ID,
      body: chunks('abc', 'def'),
      expectedBytes: 6,
    });
    expect(await files.stat(files.uploadPath(ID))).toMatchObject({ size: 6 });
    expect(readdirSync(join(root, 'uploads'))).toEqual([`${ID}.upload`]);
  });

  it('refuses and removes an upload larger than announced', async () => {
    const saving = files.saveUpload({
      mediaId: ID,
      body: chunks('abc', 'def', 'g'),
      expectedBytes: 6,
    });
    await expect(saving).rejects.toEqual(new UploadRefusedError('too-large'));
    expect(readdirSync(join(root, 'uploads'))).toEqual([]);
  });

  it('refuses and removes an upload that ended early', async () => {
    const saving = files.saveUpload({
      mediaId: ID,
      body: chunks('abc'),
      expectedBytes: 6,
    });
    await expect(saving).rejects.toEqual(new UploadRefusedError('incomplete'));
    expect(readdirSync(join(root, 'uploads'))).toEqual([]);
  });

  it('refuses and removes an upload that is not the file announced', async () => {
    const saving = files.saveUpload({
      mediaId: ID,
      body: chunks('abc'),
      expectedBytes: 3,
      sha256: '0'.repeat(64),
    });
    await expect(saving).rejects.toEqual(new UploadRefusedError('different'));
    expect(readdirSync(join(root, 'uploads'))).toEqual([]);
  });

  it('removes the partial file when the connection breaks', async () => {
    const body = new Readable({
      read() {
        this.push(Buffer.from('abc'));
        this.destroy(new Error('socket hang up'));
      },
    });
    await expect(
      files.saveUpload({ mediaId: ID, body, expectedBytes: 6 }),
    ).rejects.toThrow('socket hang up');
    expect(readdirSync(join(root, 'uploads'))).toEqual([]);
  });

  it('reads an inclusive byte range', async () => {
    await files.saveUpload({
      mediaId: ID,
      body: chunks('0123456789'),
      expectedBytes: 10,
    });
    const part = await text(
      files.read(files.uploadPath(ID), { start: 2, end: 5 }),
    );
    expect(part).toBe('2345');
  });

  it('answers null for a missing file or a folder', async () => {
    expect(await files.stat(files.audioPath(ID))).toBeNull();
    expect(await files.stat('uploads')).toBeNull();
  });

  it('discards an upload, complete or partial', async () => {
    await files.saveUpload({
      mediaId: ID,
      body: chunks('x'),
      expectedBytes: 1,
    });
    writeFileSync(join(root, `${files.uploadPath(ID)}.part`), 'y');
    await files.discardUpload(ID);
    expect(readdirSync(join(root, 'uploads'))).toEqual([]);
    await files.discardUpload(ID);
  });

  it('promotes a work file to its final path', async () => {
    const work = files.workPath(ID, '22222222-2222-4222-8222-222222222222');
    writeFileSync(join(root, work), 'aac');
    await files.promote(work, files.audioPath(ID));
    expect(await files.stat(files.audioPath(ID))).toMatchObject({ size: 3 });
    expect(await files.stat(work)).toBeNull();
  });

  it('removes files and ignores missing ones', async () => {
    await files.saveUpload({
      mediaId: ID,
      body: chunks('x'),
      expectedBytes: 1,
    });
    await files.remove([files.uploadPath(ID), files.audioPath(ID)]);
    expect(existsSync(join(root, files.uploadPath(ID)))).toBe(false);
  });

  it.each(['../secret', '/etc/passwd', 'audio/../../x'])(
    'never touches a path outside the media directory (%s)',
    async (path) => {
      expect(() => files.read(path, { start: 0, end: 1 })).toThrow(/outside/);
      await expect(files.remove([path])).rejects.toThrow(/outside/);
    },
  );

  it('fails fast when the directory cannot be written (AC-7)', async () => {
    chmodSync(root, 0o500);
    await expect(
      new FsMediaFiles(join(root, 'media')).assertWritable(),
    ).rejects.toThrow();
    await expect(new FsMediaFiles(root).assertWritable()).rejects.toThrow();
  });
});
