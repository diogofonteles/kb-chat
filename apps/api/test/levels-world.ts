/**
 * Access levels under test (KBC-103, ADR 0036): a vault written for the case, the owner
 * (master) and members with chosen grants, and helpers to build a scale and place documents.
 */
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  levelAuditEntrySchema,
  type LevelAuditEntry,
} from '@kb-chat/contracts';
import { expect } from 'vitest';
import {
  OWNER_EMAIL,
  caller,
  signIn,
  start,
  type Call,
  type Started,
} from './ai-app-harness.js';

/** One document of the test vault: where it is, its title and its body. */
export interface VaultDoc {
  /** Path from the vault root: `hermetismo/raw/qs-1.md`. */
  readonly path: string;
  readonly title: string;
  readonly body: string;
  /** Extra frontmatter lines (`related: ["[[Lua]]"]`). */
  readonly extra?: string;
}

export const doc = (
  path: string,
  title: string,
  body: string | { readonly body: string; readonly extra: string },
): VaultDoc =>
  typeof body === 'string' ? { path, title, body } : { path, title, ...body };

const markdown = ({ title, body, extra }: VaultDoc): string =>
  `---\ntitle: ${title}\ntype: source\ngenre: reference_docs\ndepth: 2\nrelevance: collected_on_purpose\nconcepts: ["[[Astrologia]]"]\nauthor_group: outros-autores\n${extra ?? ''}${extra ? '\n' : ''}---\n\n${body}\n`;

/** `hermetismo` (with the sub-collection `hermetismo/aulas`) and `alquimia`, holding `docs`. */
export async function levelsVault(docs: readonly VaultDoc[]): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kbchat-levels-'));
  await mkdir(join(root, 'hermetismo', 'aulas', 'raw'), { recursive: true });
  await mkdir(join(root, 'alquimia', 'raw'), { recursive: true });
  await writeFile(join(root, 'kb.toml'), '[vault]\nroot = "."\n');
  await writeFile(
    join(root, 'hermetismo', 'topic.yaml'),
    'title: Hermetismo\n',
  );
  await writeFile(
    join(root, 'hermetismo', 'aulas', 'topic.yaml'),
    'title: Aulas\n',
  );
  await writeFile(join(root, 'alquimia', 'topic.yaml'), 'title: Alquimia\n');
  await writeDocs(root, docs);
  return root;
}

export async function writeDocs(
  root: string,
  docs: readonly VaultDoc[],
): Promise<void> {
  for (const one of docs) {
    await mkdir(dirname(join(root, one.path)), { recursive: true });
    await writeFile(join(root, one.path), markdown(one));
  }
}

/** Six documents with "lua": two per level-to-be, one of the CI ones in the sub-collection. */
export const SIX = [
  doc(
    'hermetismo/raw/qs-1.md',
    'Lua Primeira Aberta',
    'A lua no primeiro grau.',
  ),
  doc(
    'hermetismo/raw/qs-2.md',
    'Lua Segunda Aberta',
    'A lua no segundo texto.',
  ),
  doc('hermetismo/raw/ci-1.md', 'Lua Media Uno', 'A lua no grau do meio.'),
  doc(
    'hermetismo/aulas/raw/ci-2.md',
    'Lua Media Duo',
    'A lua na aula do meio.',
  ),
  doc('hermetismo/raw/cdc-1.md', 'Zircônio Velado', 'A lua no grau velado.'),
  doc('hermetismo/raw/cdc-2.md', 'Obsidiana Velada', 'A lua oculta velada.'),
] as const;

/** The CDC titles: none of them may appear anywhere in a CI member's response. */
export const HIDDEN_TITLES = ['Zircônio Velado', 'Obsidiana Velada'];

export interface LevelsWorld {
  readonly started: Started;
  readonly vault: string;
  readonly owner: Call;
  readonly ownerHeaders: Record<string, string>;
}

export async function startLevels(
  docs: readonly VaultDoc[] = SIX,
  options: { readonly media?: boolean } = {},
): Promise<LevelsWorld> {
  const vault = await levelsVault(docs);
  const started = await start({ vault, ...options });
  const ownerHeaders = await signIn(started, OWNER_EMAIL);
  return {
    started,
    vault,
    owner: caller(started.app, ownerHeaders),
    ownerHeaders,
  };
}

/** A member who sees `topics` (default `hermetismo`) and searches. */
export async function memberOf(
  world: LevelsWorld,
  email: string,
  grant: { topics?: string[]; features?: string[] } = {},
): Promise<{ call: Call; id: string; headers: Record<string, string> }> {
  const invited = await world.owner('POST', '/api/v1/people', {
    email,
    sendEmail: false,
  });
  expect(invited.statusCode, invited.body).toBe(201);
  const id: string = invited.json().id;
  const patched = await world.owner('PATCH', `/api/v1/people/${id}`, {
    topics: grant.topics ?? ['hermetismo'],
    features: grant.features ?? ['search', 'research', 'media'],
  });
  expect(patched.statusCode, patched.body).toBe(200);
  const headers = await signIn(world.started, email);
  return { call: caller(world.started.app, headers), id, headers };
}

const levelsUrl = (topic: string) =>
  `/api/v1/topics/${encodeURIComponent(topic)}/levels`;

/** The master creates the codes in order (the first one seeds everything at it). */
export async function createScale(
  world: LevelsWorld,
  codes: readonly string[],
  topic = 'hermetismo',
): Promise<void> {
  for (const code of codes) {
    const created = await world.owner('POST', levelsUrl(topic), { code });
    expect(created.statusCode, created.body).toBe(201);
  }
}

export const documentLevelUrl = (topic: string, id: string) =>
  `/api/v1/topics/${encodeURIComponent(topic)}/documents/${encodeURIComponent(id)}/level`;

/** Places documents at levels: `{ 'hermetismo:raw/cdc-1.md': 'cdc' }`. */
export async function placeDocuments(
  world: LevelsWorld,
  levels: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [key, level] of Object.entries(levels)) {
    const [topic = '', id = ''] = key.split(':');
    const placed = await world.owner('PUT', documentLevelUrl(topic, id), {
      level,
    });
    expect(placed.statusCode, placed.body).toBe(200);
  }
}

/** QS < CI < CDC, two documents each, as AC-2 sets it. */
export async function sixAtThreeLevels(world: LevelsWorld): Promise<void> {
  await createScale(world, ['QS', 'CI', 'CDC']);
  await placeDocuments(world, {
    'hermetismo:raw/ci-1.md': 'ci',
    'hermetismo/aulas:raw/ci-2.md': 'ci',
    'hermetismo:raw/cdc-1.md': 'cdc',
    'hermetismo:raw/cdc-2.md': 'cdc',
  });
}

export const setPersonLevel = async (
  world: LevelsWorld,
  id: string,
  levels: Record<string, string>,
) => {
  const patched = await world.owner('PATCH', `/api/v1/people/${id}`, {
    levels,
  });
  expect(patched.statusCode, patched.body).toBe(200);
  return patched;
};

export const search = (call: Call, q: string, topic = 'hermetismo') =>
  call('POST', `/api/v1/topics/${encodeURIComponent(topic)}/searches`, { q });

export const titlesOf = (body: { items: { title: string }[] }): string[] =>
  body.items.map((item) => item.title).sort();

/** Every line of the levels audit, oldest first. */
export async function levelAudit(state: string): Promise<LevelAuditEntry[]> {
  const dir = join(state, 'audit');
  const names = (await readdir(dir)).filter((name) =>
    name.startsWith('levels-'),
  );
  const texts = await Promise.all(
    names.sort().map((name) => readFile(join(dir, name), 'utf8')),
  );
  return texts
    .flatMap((text) => text.split('\n'))
    .filter((line) => line !== '')
    .map((line) => levelAuditEntrySchema.parse(JSON.parse(line)));
}
