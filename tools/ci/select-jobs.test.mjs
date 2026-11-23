import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import {
  MEDIA_PAGES,
  RULES,
  mediaSpecsOf,
  selectJobs,
  specsOpening,
} from './select-jobs.mjs';

const onPullRequest = (...paths) =>
  selectJobs({ event: 'pull_request', base: 'develop', paths });

const unitNames = (chosen) => chosen.unit.include.map((job) => job.name);
const e2eShards = (chosen) =>
  chosen.e2e.include.map((job) => `${job.name} ${job.shard}`);
const e2eSpecs = (chosen, name) =>
  chosen.e2e.include.find((job) => job.name === name)?.specs;

const FULL_E2E = [
  'app 1/2',
  'app 2/2',
  'media Chrome 1/5',
  'media Chrome 2/5',
  'media Chrome 3/5',
  'media Chrome 4/5',
  'media Chrome 5/5',
  'media WebKit 1/4',
  'media WebKit 2/4',
  'media WebKit 3/4',
  'media WebKit 4/4',
];

/** What a pull request into develop runs at most: WebKit waits for the push (KBC-169). */
const PR_E2E = FULL_E2E.filter((shard) => !shard.startsWith('media WebKit'));

/** Everything; on a pull request into develop, everything but WebKit. */
function assertFull(chosen, { webkit = false } = {}) {
  assert.equal(chosen.full, true);
  assert.deepEqual(unitNames(chosen), ['api', 'web', 'libs']);
  assert.equal(chosen.transcriber, true);
  assert.equal(chosen.codex, true);
  assert.equal(chosen.webkit, webkit);
  assert.deepEqual(e2eShards(chosen), webkit ? FULL_E2E : PR_E2E);
  assert.ok(chosen.e2e.include.every((job) => job.specs === ''));
}

for (const event of ['push', 'workflow_dispatch', 'schedule'])
  test(`${event} runs everything, WebKit included`, () => {
    assertFull(selectJobs({ event, base: '', paths: [] }), { webkit: true });
  });

test('a pull request into main is a release and runs everything, WebKit included', () => {
  for (const paths of [['docs/a.md'], ['e2e/specs/media-player.spec.ts']])
    assertFull(selectJobs({ event: 'pull_request', base: 'main', paths }), {
      webkit: true,
    });
});

test('a pull request into develop never runs WebKit, and says it waits', () => {
  for (const paths of [
    ['e2e/specs/media-player.spec.ts'],
    ['apps/api/src/modules/media/serve-media.ts'],
    ['libs/player-core/src/index.ts'],
    ['pnpm-lock.yaml'],
  ]) {
    const chosen = onPullRequest(...paths);
    assert.equal(chosen.webkit, false);
    assert.ok(chosen.e2e.include.every((job) => job.browser !== 'webkit'));
    assert.match(chosen.reason, /WebKit waits for the push to develop/);
  }
  assert.doesNotMatch(onPullRequest('docs/a.md').reason, /WebKit/);
});

test('unknown changed paths run everything', () => {
  assertFull(
    selectJobs({ event: 'pull_request', base: 'develop', paths: null }),
  );
  assertFull(onPullRequest());
});

for (const path of [
  '.github/workflows/ci.yml',
  '.github/actions/setup-ffmpeg/action.yml',
  'tools/ci/select-jobs.mjs',
  'tools/heavy.sh',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'package.json',
  'apps/web/package.json',
  'e2e/package.json',
  'libs/contracts/src/media.ts',
  'apps/api/src/adapters/sqlite/media-migrations.ts',
  'e2e/playwright.config.ts',
  'e2e/proxy.e2e.mjs',
  'e2e/specs/fixtures.ts',
  'e2e/specs/media-helpers.ts',
  'e2e/specs/search-view.ts',
  'apps/api/src/e2e/server.ts',
  'apps/api/src/testing/fake-gemini.ts',
  'apps/api/test/fixtures/vault/hermetismo/a.md',
  'apps/web/src/app/testing/render.ts',
  'tsconfig.base.json',
  'apps/api/tsconfig.json',
  'apps/web/angular.json',
  'apps/api/vitest.config.ts',
  'apps/api/Dockerfile',
  'nx.json',
  '.nvmrc',
  'eslint.config.mjs',
  '.env.example',
  'something/new.txt',
])
  test(`${path} runs everything`, () => {
    assertFull(onPullRequest(path));
  });

test('one unsafe path among safe ones runs everything and says why', () => {
  const chosen = onPullRequest('docs/a.md', 'pnpm-lock.yaml');
  assertFull(chosen);
  assert.match(chosen.reason, /lockfile/);
});

test('a spec whose name the table cannot pass on runs everything', () => {
  assertFull(onPullRequest('e2e/specs/$(touch x).spec.ts'));
});

for (const path of [
  'docs/backlog/KBC-001.md',
  'README.md',
  'CLAUDE.md',
  '.claude/harness.json',
])
  test(`${path} is a document: no tests, no E2E`, () => {
    const chosen = onPullRequest(path);
    assert.equal(chosen.full, false);
    assert.deepEqual(unitNames(chosen), []);
    assert.equal(chosen.transcriber, false);
    assert.equal(chosen.codex, false);
    assert.deepEqual(chosen.e2e.include, []);
  });

test('the transcriber runs alone', () => {
  const chosen = onPullRequest('tools/transcriber/src/main.py');
  assert.equal(chosen.transcriber, true);
  assert.deepEqual(unitNames(chosen), []);
  assert.deepEqual(chosen.e2e.include, []);
});

test('deploy files run the API tests that read them and the sandbox proof', () => {
  const chosen = onPullRequest('deploy/compose.yml');
  assert.equal(chosen.codex, true);
  assert.deepEqual(unitNames(chosen), ['api']);
  assert.deepEqual(chosen.e2e.include, []);
});

test('a unit test runs only its suite', () => {
  assert.deepEqual(
    unitNames(onPullRequest('apps/api/src/modules/media/range.test.ts')),
    ['api'],
  );
  assert.deepEqual(
    e2eShards(onPullRequest('apps/web/src/app/features/chat/x.spec.ts')),
    [],
  );
  assert.deepEqual(unitNames(onPullRequest('libs/player-core/src/a.test.ts')), [
    'libs',
  ]);
});

test('the unit job that needs ffmpeg asks for it', () => {
  const [api] = onPullRequest('apps/api/src/config.ts').unit.include;
  assert.equal(api.ffmpeg, true);
});

test('an E2E spec runs itself, by its full path', () => {
  const chosen = onPullRequest('e2e/specs/access.spec.ts');
  assert.deepEqual(e2eShards(chosen), ['app 1/1']);
  assert.equal(e2eSpecs(chosen, 'app'), 'specs/access.spec.ts');
  assert.deepEqual(unitNames(chosen), []);
});

test('a media E2E spec runs in Chrome (WebKit on the push)', () => {
  const chosen = onPullRequest('e2e/specs/media-player.spec.ts');
  assert.deepEqual(e2eShards(chosen), ['media Chrome 1/1']);
});

const WEB = 'apps/web/src/app';
const ALL_MEDIA = PR_E2E.slice(2);
const chromeSpecs = (chosen) =>
  e2eSpecs(chosen, 'media Chrome')
    .split(' ')
    .map((spec) => /^specs\/(.+)\.spec\.ts$/.exec(spec)?.[1]);

test('a media page runs its unit tests and the media specs that open it', () => {
  const chosen = onPullRequest(`${WEB}/features/media/queue/queue-row.ts`);
  assert.deepEqual(unitNames(chosen), ['web']);
  const specs = chromeSpecs(chosen);
  assert.ok(specs.includes('media-queue'));
  assert.ok(specs.includes('media-upload-resume')); // opens /fila by itself
  assert.ok(!specs.includes('media-word-highlight'));
  assert.equal(
    e2eShards(chosen).length,
    Math.min(5, Math.ceil(specs.length / 3)),
  );
});

test('the media services run the specs of the pages that import them', () => {
  // corrections-api → corrections/ → tracks/track-text → the track editor and the
  // preparation (each moves on to the other by itself).
  const specs = chromeSpecs(
    onPullRequest(`${WEB}/core/media/corrections-api.ts`),
  );
  for (const spec of [
    'media-transcript-correction',
    'media-tracks-editor',
    'media-preparation',
  ])
    assert.ok(specs.includes(spec), spec);
  assert.ok(!specs.includes('media-sleep-timer'));
  // learning-api → transcribers/learning-panel → Configurações.
  assert.deepEqual(mediaSpecsOf(`${WEB}/core/media/learning-api.ts`), [
    ...mediaSpecsOf(`${WEB}/features/settings/settings-page.ts`),
  ]);
  assert.ok(
    mediaSpecsOf(`${WEB}/core/media/learning-api.ts`).includes(
      'media-learning',
    ),
  );
});

test('a template or style runs what its component runs', () => {
  for (const kind of ['html', 'css'])
    assert.deepEqual(
      mediaSpecsOf(`${WEB}/features/media/queue/queue-row.${kind}`),
      mediaSpecsOf(`${WEB}/features/media/queue/queue-row.ts`),
    );
});

test('in doubt, a media change runs every media spec', () => {
  for (const path of [
    // the player page, which nearly every spec opens, and what it shows
    `${WEB}/features/media/player/media-player.ts`,
    `${WEB}/features/media/transcript/transcript-panel.ts`,
    `${WEB}/core/media/media-engine.ts`,
    // imported by the sidebar, on every page
    `${WEB}/core/media/library-api.ts`,
    // gone, or not yet known
    `${WEB}/core/media/gone.ts`,
    `${WEB}/features/media/library/gone.html`,
    // a style no component of its name loads
    `${WEB}/features/voice-profiles/voice-profiles.css`,
    // the routes and their guards
    `${WEB}/features/media/media-routes.ts`,
    `${WEB}/features/media/library/library-access.ts`,
  ]) {
    assert.equal(mediaSpecsOf(path), 'all', path);
    assert.deepEqual(e2eShards(onPullRequest(path)), ALL_MEDIA, path);
  }
});

test('a spec opens a page by its URL, its controls or a helper it calls', () => {
  const settings = specsOpening('features/settings/settings-page.ts');
  // media-learning calls settings-helpers' openSettings, which calls the shell's.
  assert.ok(settings.includes('media-learning'));
  // media-word-highlight imports helpers with an openSettings, and never calls it.
  assert.ok(!settings.includes('media-word-highlight'));
  assert.ok(
    specsOpening('features/media/track-edit/track-bounds-page.ts').includes(
      'media-track-revisions',
    ),
  );
  // The editor takes the preparation's specs, and the other way round.
  assert.deepEqual(
    specsOpening('features/media/tracks/track-editor-page.ts'),
    specsOpening('features/media/preparation/preparation-page.ts'),
  );
});

test('every media page the table names exists and has a spec that opens it', () => {
  for (const page of Object.keys(MEDIA_PAGES)) {
    const source = readFileSync(
      new URL(`../../${WEB}/${page}`, import.meta.url),
      'utf8',
    );
    assert.match(source, /selector: 'app-/, page);
    const specs = specsOpening(page);
    assert.ok(specs === 'all' || specs.length > 0, page);
  }
});

test('every page of the media routes is in the table', () => {
  const routes = readFileSync(
    new URL(`../../${WEB}/features/media/media-routes.ts`, import.meta.url),
    'utf8',
  );
  const pages = [...routes.matchAll(/import\('\.\/([^']+)\.js'\)/g)].map(
    ([, page]) => `features/media/${page}.ts`,
  );
  assert.ok(pages.length >= 8);
  for (const page of pages) assert.ok(page in MEDIA_PAGES, page);
});

test('the rest of the media pages run every media spec', () => {
  for (const path of [
    'apps/web/src/app/features/media/player/media-player.ts',
    'apps/web/src/app/core/media/media-engine.ts',
  ])
    assert.deepEqual(e2eShards(onPullRequest(path)), PR_E2E.slice(2));
});

test('the player core runs its tests, the web app and every media spec', () => {
  const chosen = onPullRequest('libs/player-core/src/index.ts');
  assert.deepEqual(unitNames(chosen), ['web', 'libs']);
  assert.deepEqual(e2eShards(chosen), PR_E2E.slice(2));
});

test('any other web file runs every E2E, not the other unit suites', () => {
  for (const path of [
    'apps/web/src/app/core/auth/session.ts',
    'apps/web/src/app/features/shell/session-shell.ts',
    'apps/web/src/app/features/chat/view-store.ts',
    'apps/web/src/styles.css',
  ]) {
    const chosen = onPullRequest(path);
    assert.deepEqual(unitNames(chosen), ['web']);
    assert.deepEqual(e2eShards(chosen), PR_E2E);
    assert.equal(chosen.full, false);
  }
});

test('media API code runs the Chrome specs; WebKit only for the bytes it reads', () => {
  assert.deepEqual(
    e2eShards(onPullRequest('apps/api/src/media-worker/ffmpeg.ts')),
    PR_E2E.slice(2),
  );
  assert.deepEqual(
    e2eShards(onPullRequest('apps/api/src/modules/media/serve-media.ts')),
    PR_E2E.slice(2),
  );
  assert.match(
    onPullRequest('apps/api/src/modules/media/serve-media.ts').reason,
    /WebKit waits/,
  );
  assert.doesNotMatch(
    onPullRequest('apps/api/src/media-worker/ffmpeg.ts').reason,
    /WebKit/,
  );
});

test('API modules away from media run the app specs', () => {
  const chosen = onPullRequest('apps/api/src/modules/research/agent.ts');
  assert.deepEqual(unitNames(chosen), ['api']);
  assert.deepEqual(e2eShards(chosen), FULL_E2E.slice(0, 2));
});

test('the rest of the API runs every E2E', () => {
  for (const path of [
    'apps/api/src/modules/auth/session-service.ts',
    'apps/api/src/app.ts',
    'apps/api/src/config.ts',
  ])
    assert.deepEqual(e2eShards(onPullRequest(path)), PR_E2E);
});

test('specs add up across paths, and "all" wins', () => {
  const both = onPullRequest(
    'e2e/specs/access.spec.ts',
    'apps/web/src/app/features/privacy/privacy-page.ts',
  );
  assert.equal(
    e2eSpecs(both, 'app'),
    'specs/access.spec.ts specs/privacy.spec.ts',
  );
  const wins = onPullRequest(
    'e2e/specs/access.spec.ts',
    'apps/api/src/modules/research/agent.ts',
  );
  assert.deepEqual(e2eShards(wins), FULL_E2E.slice(0, 2));
  assert.equal(e2eSpecs(wins, 'app'), '');
});

test('every spec the table names exists', () => {
  const specs = new Set(
    readdirSync(new URL('../../e2e/specs/', import.meta.url)),
  );
  const named = new Set();
  for (const rule of RULES)
    for (const list of [rule.app, rule.chrome, rule.webkit])
      if (Array.isArray(list)) for (const spec of list) named.add(spec);
  assert.ok(named.size > 10);
  for (const spec of named) assert.ok(specs.has(`${spec}.spec.ts`), spec);
});

test('every web feature the table names exists', () => {
  const features = new URL('../../apps/web/src/app/features/', import.meta.url);
  for (const rule of RULES) {
    const name = /features\/(.+)\//.exec(rule.match.source)?.[1];
    if (name && !name.includes('('))
      assert.ok(
        readdirSync(features, { recursive: true }).includes(name),
        name,
      );
  }
});

// KBC-111 (ADR 0036 §12): the leakage suite and the boundary test are API tests. Whatever
// they guard (every API source, its test worlds, the shared contracts) must select them, so
// no rule added above can let a change that could reveal a hidden item skip them.
test('the level guards run whenever a path they protect changes', () => {
  const root = new URL('../../', import.meta.url);
  const guarded = ['apps/api/src', 'apps/api/test', 'libs/contracts/src']
    .flatMap((dir) =>
      readdirSync(new URL(`${dir}/`, root), { recursive: true }).map(
        (file) => `${dir}/${file}`,
      ),
    )
    .filter((path) => /\.(ts|json|md)$/.test(path));
  assert.ok(guarded.length > 500);
  const skipped = guarded.filter(
    (path) => !unitNames(onPullRequest(path)).includes('api'),
  );
  assert.deepEqual(skipped, []);
  for (const guard of [
    'apps/api/src/levels-leakage.integration.test.ts',
    'apps/api/src/levels-boundary.test.ts',
  ])
    assert.ok(guarded.includes(guard), guard);
});
