import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = (name: string): string =>
  fileURLToPath(new URL(`../../../deploy/web/${name}`, import.meta.url));

const runNode = (...args: string[]): string =>
  execFileSync(process.execPath, args, { encoding: 'utf8' });

const BUILT_INDEX = `<!doctype html>
<html lang="pt-BR">
  <head>
    <meta charset="utf-8" />
    <script>(function () { document.documentElement.dataset.x = '1'; })();</script>
    <link rel="stylesheet" href="styles-ABCD1234.css" media="print" onload="this.media='all'" />
  </head>
  <body><app-root></app-root><script src="main-WXYZ9876.js" type="module"></script></body>
</html>
`;

const versionMeta = (html: string): string | undefined =>
  /<meta name="kb-app-version" content="([^"]*)">/.exec(html)?.[1];

describe('deploy/web/version.mjs stamps the built app with its version (KBC-123 AC-7)', () => {
  let dir = '';

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kbc-version-'));
    writeFileSync(join(dir, 'index.html'), BUILT_INDEX);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const stampDir = (): string => runNode(script('version.mjs'), dir);
  const indexHtml = (): string => readFileSync(join(dir, 'index.html'), 'utf8');

  it('writes version.json and the same id in the index.html meta', () => {
    const printed = stampDir();
    const { version } = JSON.parse(
      readFileSync(join(dir, 'version.json'), 'utf8'),
    ) as { version: string };
    expect(version).toMatch(/^[0-9a-f]{12}$/);
    expect(printed).toBe(`kb-app-version ${version}\n`);
    expect(versionMeta(indexHtml())).toBe(version);
  });

  it('gives the same id to the same build and another to a build with other bundles', () => {
    stampDir();
    const first = versionMeta(indexHtml());
    // Running again (an image rebuilt from cache, say) keeps one meta and the same id.
    stampDir();
    expect(versionMeta(indexHtml())).toBe(first);
    expect(indexHtml().match(/kb-app-version/g)).toHaveLength(1);

    writeFileSync(
      join(dir, 'index.html'),
      BUILT_INDEX.replace('main-WXYZ9876.js', 'main-NEW00001.js'),
    );
    stampDir();
    expect(versionMeta(indexHtml())).not.toBe(first);
  });

  it('leaves the Content-Security-Policy as it was: a meta is not a script', () => {
    const before = runNode(script('csp.mjs'), join(dir, 'index.html'));
    stampDir();
    const after = runNode(script('csp.mjs'), join(dir, 'index.html'));
    expect(after).toBe(before);
    expect(after).toContain("script-src 'self' 'sha256-");
  });
});
