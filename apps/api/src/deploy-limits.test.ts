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
  const bundle = String.raw`-[A-Z0-9]{8}\.(js|css|webp)$`;

  it('names a hashed bundle with one pattern everywhere', () => {
    const patterns = [...edge.matchAll(/path_regexp\s+(\S+)/g)].map(
      ([, p]) => p,
    );
    expect(patterns).toEqual([bundle, bundle, bundle]);
  });

  it('keeps only an existing hashed bundle and revalidates everything else, deep SPA routes included', () => {
    // A route like /login or /conversas/<id> falls back to index.html: without no-cache the
    // browser keeps it by heuristic freshness and runs the old bundle against a new API.
    expect(edge).toMatch(
      /@hashed \{\s+path_regexp \S+\s+file\s+\}\s+header @hashed Cache-Control "public, max-age=31536000, immutable"/,
    );
    expect(edge).toMatch(
      /@unhashed not \{\s+path_regexp \S+\s+file\s+\}\s+header @unhashed Cache-Control "no-cache"/,
    );
  });

  it('answers a bundle from an older build with 404, not the shell', () => {
    // try_files takes no matcher: bundles get a handle of their own, without the fallback.
    expect(edge).toMatch(
      /@bundle path_regexp \S+\s+handle @bundle \{\s+file_server\s+\}\s+handle \{\s+try_files \{path\} \/index\.html\s+file_server\s+\}/,
    );
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
