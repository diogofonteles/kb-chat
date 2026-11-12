import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { beforeAll, describe, expect, it } from 'vitest';

/*
 * KBC-111 BR-3, FR-2 (ADR 0036 §12): only the catalog, the access levels and the composition
 * root read the whole catalog or the media store's lists; every other reader asks the person's
 * `LevelView`. The check runs on TypeScript's checker, so it follows the receiver's type (an
 * alias such as `const reg = deps.catalog` is caught), not a variable's name.
 */

const SRC = fileURLToPath(new URL('.', import.meta.url));

/** The reads that reveal content beyond a viewer, by the type that declares them. */
const MEDIA_READS = [
  'listMedia',
  'listLibrary',
  'findBySource',
  'findEverywhere',
  'getMedia',
  'getRendition',
  'trackTotal',
];
const WATCHED: Readonly<Record<string, readonly string[]>> = {
  CatalogRegistry: ['get', 'scope', 'scopeView', 'topics'],
  MediaStorePort: MEDIA_READS,
  SqliteMediaStore: MEDIA_READS,
};
const WATCHED_NAMES = new Set(Object.values(WATCHED).flat());

/**
 * What those reads return: a method of an inline type (`deps: { store: { listMedia(): … } }`)
 * with a watched name and one of these in its return type is the same read (review IMP-5).
 */
const WATCHED_RETURNS =
  /\b(TopicCatalog|ScopeView|MediaRecord|LibraryRecord|MediaRendition)\b/;

/**
 * Where those reads belong: the modules that decide, the store that implements them, and code
 * that never answers a person (local scripts, the E2E server's own test routes).
 */
const ALLOWED_PLACES: readonly RegExp[] = [
  /^modules\/(catalog|access-levels)\//,
  /^adapters\/sqlite\/sqlite-media-store\.ts$/,
  /^e2e\//,
  /^scripts\//,
];

/**
 * The readers outside those places, each pinned to the methods it uses and why it is safe.
 * Every one of them runs in the leakage suite (`levels-leakage.integration.test.ts`); a new
 * file, or a new method in one of these files, fails until it is declared here with a reason.
 */
const DECLARED: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'modules/search/search-service.ts': {
    scope:
      'the collection and its sub-collections whose hits keepCataloged filters through the view',
  },
  'modules/documents/documents-service.ts': {
    scopeView: 'every entry read is checked with view.allows (404 when hidden)',
  },
  'modules/topics/topics-service.ts': {
    get: 'a collection title and parent, no entries',
    scope: 'counts through countsOf with the actor view',
    topics: 'the collection tree (slugs and titles), no entries',
  },
  'modules/research/tools.ts': {
    get: 'the collection title for the prompt',
    scopeView: 'every entry handed to a tool passes the turn view',
  },
  'modules/research/tool-context.ts': {
    scopeView: 'resolveEntry answers null for an entry the turn view refuses',
  },
  'modules/research/sources-tool.ts': {
    scopeView: 'list_sources counts the entries the turn view allows',
  },
  'modules/research/text-finder.ts': {
    scopeView:
      'the shared folded corpus; the document set handed in is the view’s',
  },
  'modules/research/sweep/sweep-planner.ts': {
    scopeView: 'the sweep target set filtered by the turn view',
  },
  'modules/authors/authors-service.ts': {
    get: 'a collection parent, to find the top-level author list',
  },
  'modules/authors/legacy-seed.ts': {
    topics: 'the one-time seed of author lists at start, never a response',
  },
  'modules/usage/routes.ts': {
    scope: 'collection slugs for the usage event, no entries',
  },
  'modules/media/library-service.ts': {
    listLibrary: 'the library, filtered by the person view per item',
  },
  'modules/media/media-service.ts': {
    listMedia: 'the collection media list, filtered by seesMedia per item',
    findBySource:
      'the upload check: a hidden duplicate answers duplicate-hidden, naming nothing (KBC-105 FR-5)',
    findEverywhere:
      'copies in other collections, kept only when seesMedia admits them',
    getMedia: 'visible() answers 404 unless seesMedia admits the record',
    getRendition:
      'the file of a record visible() already admitted (stream, waveform)',
    trackTotal:
      'only where the person hears every level of the recording (placeOf); else counted over the tracks they hear',
  },
  'modules/media/track-levels.ts': {
    getMedia: 'the recording of an edit check (hearsAllTracks), never returned',
  },
  'modules/media/media-edit-service.ts': {
    getMedia: 'refused with MEDIA_NOT_FOUND unless seesMedia admits it',
  },
  'modules/media/silence-service.ts': {
    getMedia:
      'a parent id or a duration, after the route found the item visible (or for the worker by token)',
  },
  'modules/media/worker-service.ts': {
    getMedia: 'the worker, by its token: never a person',
    getRendition: 'the worker, by its token: never a person',
  },
  'modules/media/voice-print-service.ts': {
    getMedia: 'the worker holding the job, by its token: never a person',
  },
  'modules/media/diarization-service.ts': {
    getMedia:
      'refused (404) unless seesMedia admits it; the rest is the worker by its token',
  },
  'modules/media/transcription-service.ts': {
    getMedia: 'the Mac transcriber, by its token: never a person',
    getRendition: 'the Mac transcriber, by its token: never a person',
  },
  'modules/media/transcript-service.ts': {
    getMedia:
      "the track of a transcript readable() already admitted, for its recording's voices",
  },
  'modules/media/voice-names-service.ts': {
    getMedia: 'refused with MEDIA_NOT_FOUND unless seesMedia admits it',
  },
  'modules/media-edit/track-publisher.ts': {
    getMedia: 'publishing cut tracks (the worker and the edit), never returned',
  },
  'modules/media-edit/track-revision-service.ts': {
    getMedia:
      'behind the edit rule: who does not hear every track gets 403 EDIT_ABOVE_YOUR_LEVEL',
  },
  'modules/media-documents/document-source.ts': {
    getMedia:
      'what the Mac publishes as track documents (by token), never a person',
  },
  'modules/media-documents/publication-status.ts': {
    getMedia:
      'the publication state of an item the edit route already admitted; state only',
  },
  'modules/media-documents/track-shelf.ts': {
    getMedia:
      'a track document the view already admitted (LevelView.allows reads its level)',
  },
  'modules/track-subjects/track-subject-service.ts': {
    getMedia:
      'refused (404) unless seesMedia admits the track itself (KBC-111)',
  },
  'modules/health/routes.ts': {
    topics: 'whether the catalog is loaded: no entry, no count (KBC-111)',
  },
  'app.ts': {
    get: 'whether a collection exists and its parent, no entries',
    scope: 'collection slugs of a scope, no entries',
    scopeView:
      'the conversations re-check stored sources with the view (KBC-110)',
    topics: 'collection slugs, no entries',
    getMedia:
      'the record of a correction the edit rule already admitted (403 below a track)',
  },
  'main.ts': {
    topics: 'the largest collection to warm the index, at start',
  },
  'media-documents-factory.ts': {
    get: 'a collection title and whether it exists',
    scope: "the scope's slugs for the reconciler, never a person",
    topics:
      'what the Mac must publish and the folders it may use, never a person',
    listMedia: 'the reconciler of track documents, never a person',
  },
  'track-proposals-factory.ts': {
    get: 'the collection title for the AI prompt of an edit already admitted',
  },
  'track-subjects-factory.ts': {
    get: "the collection's concept names and title, for an edit already admitted",
  },
};

const isAllowedPlace = (path: string) =>
  ALLOWED_PLACES.some((place) => place.test(path));

function sources(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .filter((entry) => !/\.(test|bench)\.ts$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

interface Read {
  readonly file: string;
  readonly method: string;
}

type Declaration = ts.Declaration | undefined;

/** The class or interface a member is declared in, or `inline` for a type literal. */
function ownerOf(declaration: Declaration): string | undefined {
  const parent = declaration?.parent;
  if (!parent) return undefined;
  if (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent))
    return parent.name?.text;
  return ts.isTypeLiteralNode(parent) ? 'inline' : undefined;
}

const nameOf = (declaration: Declaration): string | undefined => {
  const name = declaration && ts.getNameOfDeclaration(declaration);
  return name && ts.isIdentifier(name) ? name.text : undefined;
};

/**
 * Whether a declared member is a watched read: a watched method of a watched type, or a
 * watched name on an inline type that returns what those reads return.
 */
function isWatched(
  checker: ts.TypeChecker,
  declaration: Declaration,
): string | null {
  const name = nameOf(declaration);
  const owner = ownerOf(declaration);
  if (!name || !owner || !WATCHED_NAMES.has(name)) return null;
  if (WATCHED[owner]?.includes(name)) return name;
  if (owner !== 'inline' || !declaration) return null;
  const type = checker.typeToString(checker.getTypeAtLocation(declaration));
  return WATCHED_RETURNS.test(type) ? name : null;
}

/** The member a node names: `a.get`, `a['get']`, `const { get } = a`. */
function memberOf(checker: ts.TypeChecker, node: ts.Node): Declaration {
  if (ts.isPropertyAccessExpression(node))
    return checker.getSymbolAtLocation(node.name)?.declarations?.[0];
  if (ts.isElementAccessExpression(node))
    return checker.getSymbolAtLocation(node.argumentExpression)
      ?.declarations?.[0];
  if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
    const key = node.propertyName ?? node.name;
    const from = checker.getTypeAtLocation(node.parent);
    const text = ts.isIdentifier(key) ? key.text : undefined;
    return text ? from.getProperty(text)?.declarations?.[0] : undefined;
  }
  return undefined;
}

/** The signature a call runs, through an alias, `.call`, `.apply` or `.bind` too. */
function calledOf(
  checker: ts.TypeChecker,
  node: ts.CallExpression,
): Declaration {
  const callee = node.expression;
  if (
    ts.isPropertyAccessExpression(callee) &&
    ['call', 'apply', 'bind'].includes(callee.name.text)
  )
    return checker
      .getTypeAtLocation(callee.expression)
      .getCallSignatures()[0]
      ?.getDeclaration();
  return checker.getResolvedSignature(node)?.getDeclaration();
}

function readsOf(program: ts.Program, file: ts.SourceFile): Read[] {
  const checker = program.getTypeChecker();
  const found = new Map<string, Read>();
  const path = relative(SRC, file.fileName).split('\\').join('/');
  const visit = (node: ts.Node): void => {
    const declaration = ts.isCallExpression(node)
      ? calledOf(checker, node)
      : memberOf(checker, node);
    const method = isWatched(checker, declaration);
    if (method) found.set(method, { file: path, method });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...found.values()];
}

const label = (read: Read) => `${read.file}: ${read.method}`;

/** Every watched read in the sources (and the in-memory rogue file). */
const allReads = (program: ts.Program): Read[] =>
  program
    .getSourceFiles()
    .filter((file) => file.fileName.startsWith(SRC))
    .flatMap((file) => readsOf(program, file));

/** The reads outside the allowed places and the declared list. */
const undeclared = (reads: readonly Read[]): string[] =>
  reads
    .filter((read) => !isAllowedPlace(read.file))
    .filter((read) => DECLARED[read.file]?.[read.method] === undefined)
    .map(label);

/**
 * Files of `modules/search` that read the catalog or the media store around the rule (AC-3,
 * review IMP-5), only in memory: an alias, destructuring, an index, `.call`, and an inline
 * dependency type in the style of the services' own deps.
 */
const ROGUES: Readonly<Record<string, string>> = {
  'modules/search/rogue-alias.ts': `import type { CatalogRegistry } from '../catalog/index.js';
export const titles = (deps: { catalog: CatalogRegistry }) => {
  const registry = deps.catalog;
  return [...(registry.get('hermetismo')?.entries.values() ?? [])].map((one) => one.title);
};
`,
  'modules/search/rogue-destructure.ts': `import type { CatalogRegistry } from '../catalog/index.js';
export const count = (catalog: CatalogRegistry) => {
  const { scope } = catalog;
  return scope.call(catalog, 'hermetismo').length;
};
`,
  'modules/search/rogue-index.ts': `import type { MediaStorePort } from '../../ports/media-store.js';
export const titles = (store: MediaStorePort) =>
  store['listLibrary']().map((one) => one.title);
`,
  'modules/search/rogue-inline.ts': `import type { MediaRecord } from '../../ports/media-store.js';
export const titles = (deps: { store: { listMedia(topic: string): MediaRecord[] } }) =>
  deps.store.listMedia('hermetismo').map((one) => one.title);
`,
};
const ROGUE_READS = [
  'modules/search/rogue-alias.ts: get',
  'modules/search/rogue-destructure.ts: scope',
  'modules/search/rogue-index.ts: listLibrary',
  'modules/search/rogue-inline.ts: listMedia',
];

function programWithRogue(): ts.Program {
  const options: ts.CompilerOptions = {
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['node'],
  };
  const host = ts.createCompilerHost(options);
  const getSourceFile = host.getSourceFile.bind(host);
  const rogues = new Map(
    Object.entries(ROGUES).map(([path, text]) => [join(SRC, path), text]),
  );
  host.getSourceFile = (name, version, ...rest) => {
    const text = rogues.get(name);
    return text === undefined
      ? getSourceFile(name, version, ...rest)
      : ts.createSourceFile(name, text, version);
  };
  return ts.createProgram({
    rootNames: [...sources(SRC), ...rogues.keys()],
    options,
    host,
  });
}

let found: Read[] = [];

// One program for the three checks: the checker over every source takes a few seconds.
beforeAll(() => {
  found = allReads(programWithRogue());
}, 60_000);

describe('Only the gate reads the whole catalog and the media store (KBC-111 BR-3, ADR 0036 §12)', () => {
  it('AC-3: files of modules/search reading them through an alias, destructuring, an index, .call or an inline type fail the rule', () => {
    expect(
      undeclared(found).filter((read) => read.includes('/rogue-')),
    ).toEqual(ROGUE_READS);
  });

  it('no source outside catalog, access-levels and the store reads them undeclared', () => {
    expect(
      undeclared(found).filter((read) => !read.includes('/rogue-')),
    ).toEqual([]);
  });

  it('every declared reader still reads what it declares (no stale exception)', () => {
    const used = new Set(found.map(label));
    const declared = Object.entries(DECLARED).flatMap(([file, methods]) =>
      Object.keys(methods).map((method) => `${file}: ${method}`),
    );
    expect(declared.filter((one) => !used.has(one))).toEqual([]);
  });
});
