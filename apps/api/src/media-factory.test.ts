import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';
import { createMedia } from './media-factory.js';

const TOKEN = 'a-media-worker-token-of-at-least-32-chars';
const SECRETS = { tokenKey: Buffer.alloc(32, 1) };
let root: string;

const configWith = (env: Record<string, string>) =>
  loadConfig({ KB_CHAT_MEDIA_WORKER_TOKEN: TOKEN, ...env });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kbchat-media-factory-'));
});
afterEach(() => {
  chmodSync(root, 0o700);
  rmSync(root, { recursive: true, force: true });
});

describe('createMedia (KBC-034 FR-1)', () => {
  it('opens nothing when media is off', async () => {
    expect(
      await createMedia(configWith({ KB_CHAT_MEDIA: 'off' }), SECRETS),
    ).toBeUndefined();
  });

  it('opens the store and the files when media is on', async () => {
    const media = await createMedia(
      configWith({
        KB_CHAT_MEDIA: 'on',
        KB_CHAT_MEDIA_DIR: join(root, 'media'),
      }),
      SECRETS,
    );
    expect(media?.workerToken).toBe(TOKEN);
    expect(media?.store.listMedia('hermetismo')).toEqual([]);
    media?.store.close();
  });

  it('stops the start with a clear message when the folder is read-only (AC-7)', async () => {
    chmodSync(root, 0o500);
    const config = configWith({
      KB_CHAT_MEDIA: 'on',
      KB_CHAT_MEDIA_DIR: join(root, 'media'),
    });
    await expect(createMedia(config, SECRETS)).rejects.toThrow(
      `The media library cannot start: ${join(root, 'media')} is not writable (KB_CHAT_MEDIA=on)`,
    );
  });

  it('stops the start when the database cannot open', async () => {
    const dir = join(root, 'media');
    mkdirSync(join(dir, 'media.db'), { recursive: true }); // a folder where the file goes
    writeFileSync(join(dir, 'media.db', 'x'), 'not a database');
    const config = configWith({ KB_CHAT_MEDIA: 'on', KB_CHAT_MEDIA_DIR: dir });
    await expect(createMedia(config, SECRETS)).rejects.toThrow(
      /did not open or migrate/,
    );
  });

  it('refuses media on without the worker token', () => {
    expect(() => loadConfig({ KB_CHAT_MEDIA: 'on' })).toThrow(
      /KB_CHAT_MEDIA_WORKER_TOKEN/,
    );
    expect(() =>
      loadConfig({ KB_CHAT_MEDIA: 'on', KB_CHAT_MEDIA_WORKER_TOKEN: 'short' }),
    ).toThrow(/KB_CHAT_MEDIA_WORKER_TOKEN/);
  });

  it('treats a blank token as unset', () => {
    expect(
      loadConfig({ KB_CHAT_MEDIA_WORKER_TOKEN: '' }).KB_CHAT_MEDIA_WORKER_TOKEN,
    ).toBeUndefined();
  });

  it('refuses the factory without a token even if the config was built by hand', async () => {
    const config = {
      ...configWith({ KB_CHAT_MEDIA: 'on' }),
      KB_CHAT_MEDIA_WORKER_TOKEN: undefined,
    };
    await expect(createMedia(config, SECRETS)).rejects.toThrow(
      /needs KB_CHAT_MEDIA_WORKER_TOKEN/,
    );
  });
});
