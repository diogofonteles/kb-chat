#!/usr/bin/env node
// Which CI jobs a pull request needs, from the paths it changes. The workflow calls this in
// its `changes` job; `push` to develop and main always runs the full suite.
//
// Reading the table: each changed path takes the FIRST rule that matches. A rule either
// asks for the full suite (`full`, with the reason) or names what the path touches. A path
// no rule matches runs the full suite: the safe answer to "this script does not know it".
//
//   node tools/ci/select-jobs.mjs --explain <path>...   prints the choice for those paths

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Every E2E spec of a group. */
const ALL = 'all';

const web = { unit: ['web'] };
const api = { unit: ['api'] };
/** The app specs (Chromium), at both widths. */
const appE2e = (specs = ALL) => ({ app: specs });
/** The media specs in Google Chrome only: server behaviour, the same in every browser. */
const chromeE2e = (specs = ALL) => ({ chrome: specs });
/** The media specs in Google Chrome and in WebKit: what the browser itself plays or draws. */
const mediaE2e = (specs = ALL) => ({ chrome: specs, webkit: specs });
const everyE2e = { app: ALL, chrome: ALL, webkit: ALL };

const webFeature = (feature, e2e) => ({
  match: new RegExp(`^apps/web/src/app/features/${feature}/`),
  ...web,
  ...e2e,
});

export const RULES = [
  // Shared by everything, or the safety net itself: run it all.
  { match: /^\.github\//, full: 'workflows' },
  { match: /^tools\/ci\/|^tools\/heavy\.sh$/, full: 'CI tooling' },
  { match: /^pnpm-/, full: 'lockfile or workspace' },
  { match: /(^|\/)package\.json$/, full: 'package manifest' },
  { match: /^libs\/contracts\//, full: 'shared contracts' },
  { match: /migrations?(\/|\.ts$)/, full: 'migrations' },
  { match: /^e2e\/playwright\.config\.ts$/, full: 'Playwright config' },
  { match: /^e2e\/(specs\/(?!.*\.spec\.ts$)|proxy)/, full: 'E2E helpers' },
  { match: /^apps\/api\/src\/(e2e|testing)\//, full: 'test servers and fakes' },
  { match: /^apps\/api\/test\//, full: 'test fixtures' },
  { match: /^apps\/web\/src\/app\/testing\//, full: 'test helpers' },
  {
    match:
      /(tsconfig[^/]*\.json|project\.json|angular\.json|vitest\.config\.[a-z]+|Dockerfile)$/,
    full: 'build configuration',
  },

  // Documents.
  { match: /^(docs|\.claude)\/|^(README|CLAUDE)\.md$|^\.gitignore$/ },

  // Parts with their own tests.
  { match: /^tools\/transcriber\//, transcriber: true },
  { match: /^deploy\//, ...api, codex: true }, // deploy-limits.test.ts reads deploy/
  { match: /^e2e\/tools\// }, // scripts run by hand: lint and typecheck only
  { match: /^e2e\/tutorial\//, ...appE2e(['tutorial']) },

  // A unit test changes no behaviour: only its own suite runs.
  { match: /^apps\/api\/.*\.test\.ts$/, ...api },
  { match: /^apps\/web\/.*\.spec\.ts$/, ...web },
  { match: /^libs\/player-core\/.*\.test\.ts$/, unit: ['libs'] },

  // An E2E spec runs itself.
  {
    match: /^e2e\/specs\/(media-[a-z0-9-]+)\.spec\.ts$/,
    selects: ([, spec]) => mediaE2e([spec]),
  },
  {
    match: /^e2e\/specs\/([a-z0-9-]+)\.spec\.ts$/,
    selects: ([, spec]) => appE2e([spec]),
  },

  // The player's engine, used only by the web app's media pages.
  { match: /^libs\/player-core\//, unit: ['libs', 'web'], ...mediaE2e() },

  // Web: a leaf feature runs its specs. Anything else in the app can reach any page.
  webFeature(
    'media/library',
    mediaE2e(['media-library', 'media-library-home']),
  ),
  webFeature('media/preparation', mediaE2e(['media-preparation'])),
  webFeature('media/search-hit', mediaE2e(['media-search'])),
  webFeature(
    'media/tracks',
    mediaE2e([
      'media-track-items',
      'media-track-subjects',
      'media-tracks-editor',
      'media-tracks-listen',
      'media-tracks-proposals',
      'media-tracks-recovery',
    ]),
  ),
  webFeature(
    'media/transcript',
    mediaE2e(['media-terms', 'media-transcript', 'media-transcription']),
  ),
  webFeature(
    'media/voices',
    mediaE2e(['media-voice-names', 'media-voice-profiles', 'media-voices']),
  ),
  webFeature('voice-profiles', mediaE2e(['media-voice-profiles'])),
  webFeature('transcribers', mediaE2e(['media-transcription'])),
  webFeature('media', mediaE2e()),
  { match: /^apps\/web\/src\/app\/core\/media\//, ...web, ...mediaE2e() },
  webFeature('acting', appE2e(['act-as'])),
  webFeature('authorship', appE2e(['authors'])),
  webFeature('collections', appE2e(['collections'])),
  webFeature('document', appE2e(['reading'])),
  webFeature('house-ai', appE2e(['house-ai', 'house-ai-people'])),
  webFeature('login', appE2e(['access', 'auth', 'invitation'])),
  webFeature('people', appE2e(['access', 'invitation', 'invite-presets'])),
  webFeature('privacy', appE2e(['privacy'])),
  webFeature('research', appE2e(['research'])),
  webFeature(
    'settings',
    appE2e(['codex', 'lent-subscription', 'own-ai', 'settings']),
  ),
  webFeature('tutorial', appE2e(['tutorial'])),
  { match: /^apps\/web\//, ...web, ...everyE2e },

  // API: the browser only matters where it reads the media bytes. Every API path runs the
  // API's tests, the leakage suite and the boundary test of the access levels among them
  // (KBC-111, ADR 0036 §12); select-jobs.test.mjs holds every real path to it.
  {
    match: /^apps\/api\/src\/modules\/media\/(range|serve-media)\.ts$/,
    ...api,
    ...mediaE2e(),
  },
  {
    match:
      /^apps\/api\/src\/(media-worker|adapters\/(media|sqlite)|modules\/(media|media-edit|preparation|track-proposals|track-subjects))\//,
    ...api,
    ...chromeE2e(),
  },
  {
    match:
      /^apps\/api\/src\/modules\/(access-requests|conversations|documents|health|house-ai|invite-profiles|research|search|settings|spend|usage)\//,
    ...api,
    ...appE2e(),
  },
  { match: /^apps\/api\//, ...api, ...everyE2e },
];

/**
 * `shards`: the most a group splits into, sized so the slowest shard of each takes about
 * the same time (a full run on develop, 2026-11: app ~2.5 min in three shards, media
 * Chrome ~10 min, media WebKit ~6.5 min). GitHub runs 20 jobs at once on this plan, and a
 * full run starts 18.
 */
const GROUPS = {
  app: {
    name: 'app',
    projects: '--project=desktop --project=mobile',
    browser: 'chromium',
    shards: 2,
  },
  chrome: {
    name: 'media Chrome',
    projects: '--project=media-desktop --project=media-mobile',
    browser: '',
    shards: 5,
  },
  webkit: {
    name: 'media WebKit',
    projects: '--project=media-webkit',
    browser: 'webkit',
    shards: 4,
  },
};
const SPECS_PER_SHARD = 3;

const UNITS = {
  api: { name: 'api', projects: '@kb-chat/api', ffmpeg: true },
  web: { name: 'web', projects: '@kb-chat/web', ffmpeg: false },
  libs: {
    name: 'libs',
    projects: '@kb-chat/contracts,@kb-chat/player-core,ci-tools',
    ffmpeg: false,
  },
};

const ruleFor = (path) => {
  for (const rule of RULES) {
    const found = rule.match.exec(path);
    if (found) return { ...rule, ...rule.selects?.(found) };
  }
  return { full: `no rule for ${path}` };
};

/** One group's specs after several paths: "all" wins, lists add up. */
const merged = (current, next) => {
  if (current === ALL || next === ALL) return ALL;
  return [...new Set([...(current ?? []), ...(next ?? [])])].sort();
};

function e2eMatrix(e2e) {
  return Object.entries(e2e).flatMap(([group, specs]) => {
    const all = specs === ALL;
    const { shards: most, ...job } = GROUPS[group];
    const shards = all
      ? most
      : Math.min(most, Math.ceil(specs.length / SPECS_PER_SHARD));
    return Array.from({ length: shards }, (_, index) => ({
      ...job,
      shard: `${index + 1}/${shards}`,
      specs: all ? '' : specs.map((spec) => `specs/${spec}.spec.ts`).join(' '),
    }));
  });
}

const selection = ({ reason, full, unit, transcriber, codex, e2e }) => ({
  full,
  reason,
  unit: { include: unit.map((name) => UNITS[name]) },
  transcriber,
  codex,
  e2e: { include: e2eMatrix(e2e) },
});

const fullSuite = (reason) =>
  selection({
    full: true,
    reason,
    unit: Object.keys(UNITS),
    transcriber: true,
    codex: true,
    e2e: everyE2e,
  });

/**
 * What a change runs. `paths` null means they could not be read, and no paths at all is as
 * doubtful (a pull request changes something): both run everything. A pull request into
 * anything but develop is a release, and a release runs everything.
 */
export function selectJobs({ event, base, paths }) {
  if (event !== 'pull_request') return fullSuite(`${event} runs everything`);
  if (base !== 'develop') return fullSuite(`release into ${base}`);
  if (!paths?.length) return fullSuite('the changed paths are unknown');
  const rules = paths.map(ruleFor);
  const reasons = rules.flatMap((rule) => rule.full ?? []);
  if (reasons.length) return fullSuite([...new Set(reasons)].join('; '));
  const e2e = {};
  for (const group of Object.keys(GROUPS))
    for (const rule of rules)
      if (rule[group]) e2e[group] = merged(e2e[group], rule[group]);
  return selection({
    full: false,
    reason: `${paths.length} changed path(s)`,
    unit: Object.keys(UNITS).filter((name) =>
      rules.some((rule) => rule.unit?.includes(name)),
    ),
    transcriber: rules.some((rule) => rule.transcriber),
    codex: rules.some((rule) => rule.codex),
    e2e,
  });
}

/** What the merge adds to its base: the pull request's merge commit against its first parent. */
function changedPaths() {
  try {
    return execFileSync(
      'git',
      ['diff', '--no-renames', '--name-only', 'HEAD^1', 'HEAD'],
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
}

function writeOutputs(chosen) {
  const lines = [
    `unit=${JSON.stringify(chosen.unit)}`,
    `run_unit=${chosen.unit.include.length > 0}`,
    `transcriber=${chosen.transcriber}`,
    `codex=${chosen.codex}`,
    `e2e=${JSON.stringify(chosen.e2e)}`,
    `run_e2e=${chosen.e2e.include.length > 0}`,
  ];
  appendFileSync(process.env['GITHUB_OUTPUT'], `${lines.join('\n')}\n`);
}

function main(argv) {
  const explain = argv[0] === '--explain';
  const chosen = selectJobs(
    explain
      ? { event: 'pull_request', base: 'develop', paths: argv.slice(1) }
      : {
          event: process.env['GITHUB_EVENT_NAME'],
          base: process.env['GITHUB_BASE_REF'],
          paths:
            process.env['GITHUB_EVENT_NAME'] === 'pull_request'
              ? changedPaths()
              : [],
        },
  );
  process.stdout.write(`${JSON.stringify(chosen, null, 2)}\n`);
  if (!explain) writeOutputs(chosen);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  main(process.argv.slice(2));
