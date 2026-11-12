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
const WATCHED: Readonly<Record<string, readonly string[]>> = {
  CatalogRegistry: ['get', 'scope', 'scopeView', 'topics'],
  MediaStorePort: [
    'listMedia',
    'listLibrary',
    'findBySource',
    'findEverywhere',
  ],
  SqliteMediaStore: [
    'listMedia',
    'listLibrary',
    'findBySource',
    'findEverywhere',
  ],
};

/** Where those reads belong: the modules that decide, and the composition root. */
const ALLOWED_PLACES: readonly RegExp[] = [
  /^modules\/(catalog|access-levels)\//,
  /^(app|main)\.ts$/,
  /^[a-z-]+-factory\.ts$/,
  /^e2e\//,
  /^scripts\//,
  /^adapters\/sqlite\/sqlite-media-store\.ts$/,
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
  'modules/media/media-service.ts': {
    listMedia: 'the collection media list, filtered by seesMedia per item',
    findBySource:
      'the upload check: a hidden duplicate answers duplicate-hidden, naming nothing (KBC-105 FR-5)',
    findEverywhere:
      'copies in other collections, kept only when seesMedia admits them',
  },
  'modules/media/library-service.ts': {
    listLibrary: 'the library, filtered by the person view per item',
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

/** Whom a called method belongs to: the class or interface that declares it. */
function ownerOf(checker: ts.TypeChecker, name: ts.Node): string | undefined {
  const declaration = checker.getSymbolAtLocation(name)?.declarations?.[0];
  const parent = declaration?.parent;
  return parent &&
    (ts.isClassDeclaration(parent) || ts.isInterfaceDeclaration(parent))
    ? parent.name?.text
    : undefined;
}

function readsOf(program: ts.Program, file: ts.SourceFile): Read[] {
  const checker = program.getTypeChecker();
  const found: Read[] = [];
  const path = relative(SRC, file.fileName).split('\\').join('/');
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertyAccessExpression(node) &&
      WATCHED[ownerOf(checker, node.name) ?? '']?.includes(node.name.text)
    )
      found.push({ file: path, method: node.name.text });
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
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

/** A file of `modules/search` that reads the catalog directly (AC-3), only in memory. */
const ROGUE = join(SRC, 'modules/search/rogue-catalog-read.ts');
const ROGUE_TEXT = `import type { CatalogRegistry } from '../catalog/index.js';
export const titles = (deps: { catalog: CatalogRegistry }) => {
  const registry = deps.catalog;
  return [...(registry.get('hermetismo')?.entries.values() ?? [])].map((one) => one.title);
};
`;

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
  host.getSourceFile = (name, version, ...rest) =>
    name === ROGUE
      ? ts.createSourceFile(name, ROGUE_TEXT, version)
      : getSourceFile(name, version, ...rest);
  return ts.createProgram({
    rootNames: [...sources(SRC), ROGUE],
    options,
    host,
  });
}

let found: Read[] = [];

// One program for the three checks: the checker over every source takes a few seconds.
beforeAll(() => {
  found = allReads(programWithRogue());
}, 60_000);

const ROGUE_READ = 'modules/search/rogue-catalog-read.ts: get';

describe('Only the gate reads the whole catalog and the media lists (KBC-111 BR-3, ADR 0036 §12)', () => {
  it('AC-3: a file of modules/search that calls CatalogRegistry.get (through an alias) fails the rule', () => {
    expect(undeclared(found)).toContain(ROGUE_READ);
  });

  it('no source outside catalog, access-levels and the composition root reads them undeclared', () => {
    expect(undeclared(found).filter((read) => read !== ROGUE_READ)).toEqual([]);
  });

  it('every declared reader still reads what it declares (no stale exception)', () => {
    const used = new Set(found.map(label));
    const declared = Object.entries(DECLARED).flatMap(([file, methods]) =>
      Object.keys(methods).map((method) => `${file}: ${method}`),
    );
    expect(declared.filter((one) => !used.has(one))).toEqual([]);
  });
});
