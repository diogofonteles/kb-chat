import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MEDIA_MAX_UPLOAD_BYTES } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';

const caddyfile = readFileSync(
  fileURLToPath(new URL('../../../deploy/Caddyfile', import.meta.url)),
  'utf8',
);

const compose = readFileSync(
  fileURLToPath(new URL('../../../deploy/compose.yml', import.meta.url)),
  'utf8',
);

const UNITS: Record<string, number> = {
  MiB: 1024 ** 2,
  MB: 1000 ** 2,
  GiB: 1024 ** 3,
  GB: 1000 ** 3,
};

describe('deploy limits match the contract', () => {
  it('lets the proxy pass every upload the API accepts (KBC-034 FR-2)', () => {
    const block = caddyfile.slice(caddyfile.indexOf('handle @mediaUpload'));
    const match = /max_size\s+(\d+)(MiB|MB|GiB|GB)/.exec(block);
    expect(match).not.toBeNull();
    const [, amount = '0', unit = 'MB'] = match ?? [];
    expect(Number(amount) * (UNITS[unit] ?? 0)).toBeGreaterThan(
      MEDIA_MAX_UPLOAD_BYTES,
    );
  });

  it('never makes a media-only variable required for the whole compose file (media off)', () => {
    // Compose interpolates every service, even one whose profile is off: a `:?` on a media
    // variable would stop every deploy that keeps the media library off.
    const required = [...compose.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map(
      ([, name]) => name,
    );
    expect(required.filter((name) => name?.includes('MEDIA'))).toEqual([]);
  });
});
