#!/usr/bin/env node
// Which CI jobs a pull request needs, from the paths it changes. The workflow calls this in
// its `changes` job; `push` to develop and main always runs the full suite.
//
// WebKit (the media WebKit shards) runs on `push` to develop and main and on a pull request
// into main (a promotion), never on a pull request into develop: there Chromium (the app
// specs) and Google Chrome (the media specs) carry the change, and the push of its merge to
// develop runs WebKit in full before anything is promoted (KBC-169). The CI verdict passes
// a pull request whose WebKit shards were not selected: they are simply not in the matrix.
//
// Reading the table: each changed path takes the FIRST rule that matches. A rule either
// asks for the full suite (`full`, with the reason) or names what the path touches. A path
// no rule matches runs the full suite: the safe answer to "this script does not know it".
//
// The web app's media code (core/media, features/media and the two settings sections only
// the media specs open) is read, not listed: the script walks up its imports to the media
// pages they end in, and runs the media specs that open those pages (see MEDIA_PAGES and
// mediaWalk; KBC-169). Anything it is not sure of runs every media spec.
//
//   node tools/ci/select-jobs.mjs --explain [--base main] <path>...   prints the choice for
//   those paths in a pull request into develop (or into the base given)

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/**
 * The web app's media code, from its services (core/media) to its pages, and the two
 * settings sections that only the media specs open. Its unit tests (`.spec.ts`) take the
 * rule above it.
 */
/** An upload through the page's file field moves on to the preparation or the queue. */
const UPLOAD = ['input[type="file"]', 'setInputFiles'];

const MEDIA_CODE =
  /^apps\/web\/src\/app\/(core\/media|features\/(media|transcribers|voice-profiles))\//;

/**
 * Where a walk up the imports may pass through: the media code, and the settings that host
 * two of its panels. Any other importer (the shell, the sidebar, the chat page, the router)
 * shows the file on every media page: the walk stops there and runs every media spec.
 */
const WALKABLE =
  /^apps\/web\/src\/app\/(core\/media|features\/(media|transcribers|voice-profiles|settings))\//;

/**
 * The media pages, and what in a spec (or in a helper it calls) says it opens one: the
 * page's URL, the names of the controls that lead to it, what sends a person there by
 * itself (an upload through the file field opens the preparation or the queue), and always
 * the page's own component selector, read from the page. `also`: the pages that move on to
 * this one by themselves, whose specs it takes too. `ALL`: the player, which nearly every
 * media spec opens, and the media list for who has no library: a change under them runs
 * every media spec.
 *
 * What this cannot see is a spec that reaches a page by a control named only by data (a
 * queue card names the media's title): such a spec is chosen by the page it starts from, as
 * the leaf rules always did, and the push to develop runs every spec anyway.
 */
export const MEDIA_PAGES = {
  'features/media/library/library-page.ts': {
    markers: ['/biblioteca', "'/midia'", 'Biblioteca', 'Mídia'],
  },
  'features/media/queue/processing-queue-page.ts': {
    markers: ['/fila', 'Fila', 'processamento', 'atenção', ...UPLOAD],
  },
  'features/media/preparation/preparation-page.ts': {
    // "Preparar áudio" (the player's ⋯), "Preparação parada no passo 2 · Continuar"
    markers: [
      '/preparar',
      'Preparar',
      'reparação',
      'Parada no passo',
      ...UPLOAD,
    ],
    also: ['features/media/tracks/track-editor-page.ts'],
  },
  'features/media/tracks/track-editor-page.ts': {
    // "Abrir a edição", "Ver edição", "Continuar validando", the queue's "Validar"
    markers: ['/faixas', 'edição', 'validando', 'Validar'],
    also: ['features/media/preparation/preparation-page.ts'],
  },
  'features/media/track-edit/track-bounds-page.ts': {
    markers: ['/limites', 'Ajustar início e fim'],
  },
  'features/media/my-bookmarks-page.ts': {
    markers: ['/midia/marcadores', 'marcadores'],
  },
  'features/settings/settings-page.ts': {
    markers: [
      '/configuracoes',
      'Configurações',
      'Pessoas e permissões',
      'Conectar a minha IA',
    ],
  },
  'features/media/media-player-page.ts': ALL,
  'features/media/media-list-page.ts': ALL,
  'features/media/library/media-redirect.ts': ALL,
};

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WEB_SRC = 'apps/web/src';
const APP = `${WEB_SRC}/app/`;
const ALIASES = { '@core/': 'core/', '@features/': 'features/', '@ui/': 'ui/' };
const IMPORT = /(?:\bfrom|\bimport\(?)\s*['"]([^'"]+)['"]/g;
const sourceOf = (path) => readFileSync(join(ROOT, path), 'utf8');

/** A specifier of `from`, relative or aliased, as a path from the root; null for packages. */
function resolved(from, specifier) {
  const alias = Object.keys(ALIASES).find((key) => specifier.startsWith(key));
  const target = alias
    ? `${APP}${ALIASES[alias]}${specifier.slice(alias.length)}`
    : specifier.startsWith('.')
      ? normalize(join(dirname(from), specifier))
      : null;
  return target && `${target.replace(/\.js$/, '')}.ts`;
}

let importersCache;
/** Who imports each file of the web app (its unit tests and test helpers left out). */
function importers() {
  if (importersCache) return importersCache;
  importersCache = new Map();
  const files = readdirSync(join(ROOT, WEB_SRC), { recursive: true })
    .map((file) => `${WEB_SRC}/${file}`)
    .filter(
      (path) =>
        path.endsWith('.ts') &&
        !path.endsWith('.spec.ts') &&
        !path.startsWith(`${APP}testing/`),
    );
  for (const file of files)
    for (const [, specifier] of sourceOf(file).matchAll(IMPORT)) {
      const target = resolved(file, specifier);
      if (!target) continue;
      if (!importersCache.has(target)) importersCache.set(target, new Set());
      importersCache.get(target).add(file);
    }
  return importersCache;
}

const SPECS = 'e2e/specs';
/** A top-level declaration of an E2E module, at the start of a line. */
const DECLARATION =
  /^(?:export\s+)?(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm;
const mentions = (text, name) =>
  new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(text);

let modulesCache;
/**
 * The E2E specs and their local helpers, each cut into its top-level declarations, with the
 * names it imports from other local modules (`local name → [module, exported name]`).
 */
function e2eModules() {
  if (modulesCache) return modulesCache;
  modulesCache = new Map();
  for (const file of readdirSync(join(ROOT, SPECS)).filter((f) =>
    f.endsWith('.ts'),
  )) {
    const path = `${SPECS}/${file}`;
    const source = sourceOf(path);
    const starts = [...source.matchAll(DECLARATION)];
    const parts = starts.map((found, index) => ({
      name: found[1],
      text: source.slice(found.index, starts[index + 1]?.index),
    }));
    const imported = new Map();
    for (const [, names, from] of source.matchAll(
      /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'(\.\/[^']+)'/g,
    ))
      for (const entry of names.split(',')) {
        const [name, alias = name] = entry
          .replace(/^\s*type\s+/, '')
          .split(/\s+as\s+/)
          .map((part) => part.trim());
        if (name) imported.set(alias, [resolved(path, from), name]);
      }
    modulesCache.set(path, { source, parts, imported });
  }
  return modulesCache;
}

/**
 * The media specs that open a page: the spec names its URL or component, or calls a helper
 * whose declaration does (or calls one that does, through any number of helpers). A helper
 * module only imported, its other functions unused, does not count.
 */
export function specsOpening(page, seen = new Set([page])) {
  const entry = MEDIA_PAGES[page];
  if (entry === ALL) return ALL;
  const selector = /selector: '([^']+)'/.exec(sourceOf(`${APP}${page}`))?.[1];
  const all = selector ? [...entry.markers, selector] : entry.markers;
  const modules = e2eModules();
  /** `module path → declared names that reach the page`, grown until it stops growing. */
  const reaching = new Map(
    [...modules.keys()].map((path) => [path, new Set()]),
  );
  const reaches = (path, text) => {
    const { parts, imported } = modules.get(path);
    return (
      all.some((marker) => text.includes(marker)) ||
      parts.some(
        ({ name }) => reaching.get(path).has(name) && mentions(text, name),
      ) ||
      [...imported].some(
        ([alias, [from, name]]) =>
          reaching.get(from)?.has(name) && mentions(text, alias),
      )
    );
  };
  for (let grew = true; grew;) {
    grew = false;
    for (const [path, { parts }] of modules)
      for (const { name, text } of parts)
        if (!reaching.get(path).has(name) && reaches(path, text)) {
          reaching.get(path).add(name);
          grew = true;
        }
  }
  const opening = new Set(
    [...modules]
      .map(([path, { source }]) => [
        /^e2e\/specs\/(media-[a-z0-9-]+)\.spec\.ts$/.exec(path)?.[1],
        reaches(path, source),
      ])
      .filter(([spec, opens]) => spec && opens)
      .map(([spec]) => spec),
  );
  for (const from of entry.also ?? []) {
    if (seen.has(from)) continue;
    seen.add(from);
    const theirs = specsOpening(from, seen);
    if (theirs === ALL) return ALL;
    for (const spec of theirs) opening.add(spec);
  }
  return [...opening].sort();
}

/**
 * The media specs a change to `path` needs (`specs`), and why it is every one (`why`): walk
 * up the web app's imports from it and take the specs of every media page reached. Fails
 * safe, to every media spec (`ALL`), when the file is gone or is a template or style no
 * component of the same name loads, when the walk meets an importer outside the media code
 * (see WALKABLE) or a file nothing imports, and when a page reached has no spec that opens
 * it.
 */
export function mediaWalk(path) {
  const every = (why) => ({ specs: ALL, why });
  let start = path;
  if (/\.(html|css)$/.test(path)) {
    start = path.replace(/\.(html|css)$/, '.ts');
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (
      !existsSync(join(ROOT, start)) ||
      !sourceOf(start).includes(`./${name}`)
    )
      return every('no component of its name loads it');
  }
  if (!start.endsWith('.ts') || !existsSync(join(ROOT, start)))
    return every('not in the tree');
  const specs = new Set();
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    const page = relative(APP, file);
    if (page in MEDIA_PAGES) {
      const opened = specsOpening(page);
      if (opened === ALL) return every(`reaches ${page}`);
      if (opened.length === 0) return every(`no spec opens ${page}`);
      for (const spec of opened) specs.add(spec);
      continue;
    }
    if (!WALKABLE.test(file)) return every(`imported by ${file}`);
    const by = importers().get(file) ?? new Set();
    if (by.size === 0) return every(`nothing imports ${file}`);
    for (const importer of by)
      if (!seen.has(importer)) {
        seen.add(importer);
        queue.push(importer);
      }
  }
  return { specs: [...specs].sort() };
}

export const mediaSpecsOf = (path) => mediaWalk(path).specs;

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

  // Web: the media code runs the media specs of the pages that import it (see mediaSpecsOf,
  // KBC-169). A leaf feature runs its specs. Anything else in the app can reach any page.
  {
    match: MEDIA_CODE,
    ...web,
    selects: ({ input }) => {
      const { specs, why } = mediaWalk(input);
      return {
        ...mediaE2e(specs),
        note: why && `${input}: every media spec, ${why}`,
      };
    },
  },
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
  webkit: 'webkit' in e2e,
  unit: { include: unit.map((name) => UNITS[name]) },
  transcriber,
  codex,
  e2e: { include: e2eMatrix(e2e) },
});

/** On a pull request into develop the WebKit group stays out (see the header). */
const withoutWebkit = (e2e) =>
  Object.fromEntries(
    Object.entries(e2e).filter(([group]) => group !== 'webkit'),
  );
const WEBKIT_WAITS = 'WebKit waits for the push to develop';

const fullSuite = (reason, { webkit = true } = {}) =>
  selection({
    full: true,
    reason: webkit ? reason : `${reason}; ${WEBKIT_WAITS}`,
    unit: Object.keys(UNITS),
    transcriber: true,
    codex: true,
    e2e: webkit ? everyE2e : withoutWebkit(everyE2e),
  });

/**
 * What a change runs. `paths` null means they could not be read, and no paths at all is as
 * doubtful (a pull request changes something): both run everything. A pull request into
 * anything but develop is a release, and a release runs everything, WebKit included.
 */
export function selectJobs({ event, base, paths }) {
  if (event !== 'pull_request') return fullSuite(`${event} runs everything`);
  if (base !== 'develop') return fullSuite(`release into ${base}`);
  const intoDevelop = { webkit: false };
  if (!paths?.length)
    return fullSuite('the changed paths are unknown', intoDevelop);
  const rules = paths.map(ruleFor);
  const reasons = rules.flatMap((rule) => rule.full ?? []);
  if (reasons.length)
    return fullSuite([...new Set(reasons)].join('; '), intoDevelop);
  const e2e = {};
  for (const group of Object.keys(GROUPS))
    for (const rule of rules)
      if (rule[group]) e2e[group] = merged(e2e[group], rule[group]);
  const notes = [
    ...rules.flatMap((rule) => rule.note ?? []),
    ...('webkit' in e2e ? [WEBKIT_WAITS] : []),
  ];
  return selection({
    full: false,
    reason: [`${paths.length} changed path(s)`, ...notes].join('; '),
    unit: Object.keys(UNITS).filter((name) =>
      rules.some((rule) => rule.unit?.includes(name)),
    ),
    transcriber: rules.some((rule) => rule.transcriber),
    codex: rules.some((rule) => rule.codex),
    e2e: withoutWebkit(e2e),
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

/** `--explain [--base <branch>] <path>...`: a pull request into develop unless told. */
function explained(args) {
  const base = args[0] === '--base' ? args[1] : 'develop';
  const paths = args[0] === '--base' ? args.slice(2) : args;
  return { event: 'pull_request', base, paths };
}

function main(argv) {
  const explain = argv[0] === '--explain';
  const chosen = selectJobs(
    explain
      ? explained(argv.slice(1))
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
