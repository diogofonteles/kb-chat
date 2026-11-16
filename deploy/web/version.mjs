#!/usr/bin/env node
// Stamps the built SPA with its version (KBC-123), so a tab left open across a deploy can
// tell it runs an old app and reload.
//   node deploy/web/version.mjs apps/web/dist/browser
// The id is a short sha256 of the index.html Angular built: it already names every bundle
// by its content hash, so the same sources give the same id locally and in CI, with no
// build argument. Writes <dir>/version.json ({"version":"<id>"}) and puts
// <meta name="kb-app-version" content="<id>"> in <dir>/index.html. Runs before csp.mjs: a
// meta is not a script, so the policy's hashes do not change.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const VERSION_META = 'kb-app-version';

const META_PATTERN = new RegExp(
  `\\s*<meta name="${VERSION_META}" content="[^"]*" ?/?>`,
  'g',
);

/** The page as Angular built it: a stamp from an earlier run is not part of the id. */
const unstamped = (html) => html.replace(META_PATTERN, '');

/** The version id of a built index.html. */
export function versionOf(html) {
  return createHash('sha256')
    .update(unstamped(html), 'utf8')
    .digest('hex')
    .slice(0, 12);
}

/** The index.html with its version meta, right after <head>. */
export function stamp(html, version) {
  const page = unstamped(html);
  if (!/<head[^>]*>/i.test(page)) throw new Error('index.html has no <head>');
  return page.replace(
    /<head[^>]*>/i,
    (head) => `${head}\n    <meta name="${VERSION_META}" content="${version}">`,
  );
}

/** Stamps the built app in `dir`; returns the version id. */
export function stampBuild(dir) {
  const indexPath = join(dir, 'index.html');
  const html = readFileSync(indexPath, 'utf8');
  const version = versionOf(html);
  writeFileSync(indexPath, stamp(html, version));
  writeFileSync(join(dir, 'version.json'), `${JSON.stringify({ version })}\n`);
  return version;
}

const [, , dir] = process.argv;
if (dir) process.stdout.write(`kb-app-version ${stampBuild(dir)}\n`);
