import { describe, expect, it } from 'vitest';
import { loadWorkerConfig } from './worker-config.js';

const BASE = {
  KB_CHAT_MEDIA_API_URL: 'http://api:3000',
  KB_CHAT_MEDIA_WORKER_TOKEN: 'a-media-worker-token-of-at-least-32-chars',
};

describe('loadWorkerConfig', () => {
  it('uses the production defaults: /data/media and ffmpeg by absolute path', () => {
    const config = loadWorkerConfig(BASE);
    expect(config).toMatchObject({
      KB_CHAT_MEDIA_DIR: '/data/media',
      FFMPEG_BIN: '/usr/bin/ffmpeg',
      FFPROBE_BIN: '/usr/bin/ffprobe',
      KB_CHAT_MEDIA_POLL_MS: 3_000,
      KB_CHAT_MEDIA_ALIVE_FILE: '/tmp/media-worker.alive',
    });
    expect(config.KB_CHAT_MEDIA_WORKER_NAME.length).toBeGreaterThan(0);
  });

  it('names every invalid setting, never their values', () => {
    const attempt = () =>
      loadWorkerConfig({
        KB_CHAT_MEDIA_API_URL: 'not a url',
        KB_CHAT_MEDIA_WORKER_TOKEN: 'secret',
      });
    expect(attempt).toThrow(
      'Invalid media worker configuration: KB_CHAT_MEDIA_API_URL, KB_CHAT_MEDIA_WORKER_TOKEN',
    );
    expect(attempt).not.toThrow(/secret/);
  });

  it('refuses to start with the empty token compose passes when it is unset', () => {
    expect(() =>
      loadWorkerConfig({ ...BASE, KB_CHAT_MEDIA_WORKER_TOKEN: '' }),
    ).toThrow('KB_CHAT_MEDIA_WORKER_TOKEN');
  });
});
