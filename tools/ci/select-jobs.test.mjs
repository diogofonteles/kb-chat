import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { test } from 'node:test';
import { RULES, selectJobs } from './select-jobs.mjs';

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

function assertFull(chosen) {
  assert.equal(chosen.full, true);
  assert.deepEqual(unitNames(chosen), ['api', 'web', 'libs']);
  assert.equal(chosen.transcriber, true);
  assert.equal(chosen.codex, true);
  assert.deepEqual(e2eShards(chosen), FULL_E2E);
  assert.ok(chosen.e2e.include.every((job) => job.specs === ''));
}

for (const event of ['push', 'workflow_dispatch', 'schedule'])
  test(`${event} runs everything`, () => {
    assertFull(selectJobs({ event, base: '', paths: [] }));
  });

test('a pull request into main is a release and runs everything', () => {
  assertFull(
    selectJobs({ event: 'pull_request', base: 'main', paths: ['docs/a.md'] }),
  );
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

test('a media E2E spec runs in Chrome and in WebKit', () => {
  const chosen = onPullRequest('e2e/specs/media-player.spec.ts');
  assert.deepEqual(e2eShards(chosen), ['media Chrome 1/1', 'media WebKit 1/1']);
});

test('a leaf web feature runs its unit tests and its specs', () => {
  const chosen = onPullRequest(
    'apps/web/src/app/features/media/library/library-page.ts',
  );
  assert.deepEqual(unitNames(chosen), ['web']);
  assert.deepEqual(e2eShards(chosen), ['media Chrome 1/1', 'media WebKit 1/1']);
  assert.equal(
    e2eSpecs(chosen, 'media Chrome'),
    'specs/media-library.spec.ts specs/media-library-home.spec.ts',
  );
});

test('the rest of the media pages run every media spec', () => {
  for (const path of [
    'apps/web/src/app/features/media/player/media-player.ts',
    'apps/web/src/app/core/media/media-engine.ts',
  ])
    assert.deepEqual(e2eShards(onPullRequest(path)), FULL_E2E.slice(2));
});

test('the player core runs its tests, the web app and every media spec', () => {
  const chosen = onPullRequest('libs/player-core/src/index.ts');
  assert.deepEqual(unitNames(chosen), ['web', 'libs']);
  assert.deepEqual(e2eShards(chosen), FULL_E2E.slice(2));
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
    assert.deepEqual(e2eShards(chosen), FULL_E2E);
    assert.equal(chosen.full, false);
  }
});

test('media API code runs the Chrome specs; WebKit only for the bytes it reads', () => {
  assert.deepEqual(
    e2eShards(onPullRequest('apps/api/src/media-worker/ffmpeg.ts')),
    FULL_E2E.slice(2, 7),
  );
  assert.deepEqual(
    e2eShards(onPullRequest('apps/api/src/modules/media/serve-media.ts')),
    FULL_E2E.slice(2),
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
    assert.deepEqual(e2eShards(onPullRequest(path)), FULL_E2E);
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

test("a longer list of specs takes more shards, up to its group's most", () => {
  const chosen = onPullRequest(
    'apps/web/src/app/features/media/tracks/track-group.ts',
  );
  assert.deepEqual(e2eShards(chosen), [
    'media Chrome 1/2',
    'media Chrome 2/2',
    'media WebKit 1/2',
    'media WebKit 2/2',
  ]);
});

test('every spec the table names exists', () => {
  const specs = new Set(
    readdirSync(new URL('../../e2e/specs/', import.meta.url)),
  );
  const named = new Set();
  for (const rule of RULES)
    for (const list of [rule.app, rule.chrome, rule.webkit])
      if (Array.isArray(list)) for (const spec of list) named.add(spec);
  assert.ok(named.size > 20);
  for (const spec of named) assert.ok(specs.has(`${spec}.spec.ts`), spec);
});

test('every web feature the table names exists', () => {
  const features = new URL('../../apps/web/src/app/features/', import.meta.url);
  for (const rule of RULES) {
    const name = /features\/(.+)\//.exec(rule.match.source)?.[1];
    if (name)
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
