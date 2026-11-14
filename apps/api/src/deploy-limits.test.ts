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

describe('the web edge never lets a browser keep an old app (KBC-122)', () => {
  const edge = caddyfile.slice(caddyfile.indexOf('root * /srv/www'));

  it('sends no-cache on every response that is not a hashed bundle, deep SPA routes included', () => {
    // A route like /login or /conversas/<id> falls back to index.html: without no-cache the
    // browser keeps it by heuristic freshness and runs the old bundle against a new API.
    expect(edge).toMatch(
      /@unhashed\s+not\s+path_regexp\s+-\[A-Z0-9\]\{8\}\\\.\(js\|css\|webp\)\$/,
    );
    expect(edge).toMatch(/header\s+@unhashed\s+Cache-Control\s+"no-cache"/);
    expect(edge).not.toMatch(/@html\s+path\s/);
  });
});

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
