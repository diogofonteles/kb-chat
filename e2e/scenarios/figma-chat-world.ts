import { randomUUID } from 'node:crypto';
import { request } from '@playwright/test';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
import {
  CSRF,
  OWNER_EMAIL,
  WEB_ORIGIN,
  expect,
  invite,
  ownerApi,
} from '../specs/fixtures.js';

/**
 * The sample data of the v2 · Conversa frames (chat-*), seeded on a FRESH E2E server so the
 * app shows what the frames show. Most of it is the E2E server's own: Hermetismo and its 22
 * documents (Mestre Laércio), the stub model's research ("Pesquisou 2 vezes · leu 1 documento",
 * "Segundo o acervo, “A Lei do Ritmo” trata do assunto [1].", stub/model) and the owner's
 * spend (US$ 0,03 de 1,00).
 *
 * Seeded for real, through the API: the collections "Cabala" and "Cosmologia Espiritual", the
 * owner's conversations of "Sua biblioteca" (newest first: "Quais livros o Mestre recomenda?",
 * failed; "O que é a natureza sétupla?", interrupted; "lei do ritmo", a search; and
 * "transmutação dos metais", a search of Alquimia Prática, which only the phone's lists draw),
 * the exhaustive turn "Quais obras o Mestre cita como referência?" with its incomplete sweep
 * (chat-research-continue), a member with no collection (chat-no-topics) and "Ana Lima", the
 * person the owner acts as (chat-acting), with the same conversations.
 *
 * Patched in the responses (`chatWorld`), each because no API can set it:
 * - GET /api/v1/topics has the frames' three collections only (the E2E server's "Zz …" level
 *   collections and Alquimia Prática are left out), "Cabala" with 9 documents and "Cosmologia
 *   Espiritual" with 6 (documents come from the kb vault, which no API writes); a state may
 *   make it fail, empty, or Hermetismo without texts;
 * - GET /api/v1/conversations lists the frames' conversations only (a state's own turn, like
 *   the one asked live in chat-research-answer, stays off the list), and for the member with
 *   no collection, who can keep none, it is the owner's list.
 */

export const OWNER = OWNER_EMAIL;
export const HERMETISMO = 'hermetismo';
export const CABALA = 'Cabala';
export const COSMOLOGIA = 'Cosmologia Espiritual';
/** The frames' document counts of the collections made on the screen. */
const COUNTS: Record<string, number> = { [CABALA]: 9, [COSMOLOGIA]: 6 };

export const CONVERSATIONS = {
  failed: 'Quais livros o Mestre recomenda?',
  interrupted: 'O que é a natureza sétupla?',
  search: 'lei do ritmo',
  alchemy: 'transmutação dos metais',
  sweep: 'Quais obras o Mestre cita como referência?',
} as const;
/** What "Sua biblioteca" lists in the frames (desktop): three conversations. */
export const LISTED = [
  CONVERSATIONS.failed,
  CONVERSATIONS.interrupted,
  CONVERSATIONS.search,
] as const;
/** The phone's Conversas and Menu add the Alquimia Prática search (chat-history@mobile). */
export const LISTED_PHONE = [...LISTED, CONVERSATIONS.alchemy] as const;

export const ANA = {
  email: 'ana.lima@kb-chat.test',
  name: 'Ana Lima',
} as const;
export const NO_TOPICS = 'figma-sem-acervo@kb-chat.test';

export interface ChatWorld {
  readonly cabala: string;
  readonly cosmologia: string;
  readonly anaId: string;
  /** Conversation id by title. */
  readonly conversations: Record<string, string>;
  /** When each was saved as seeded: opening one again (a search re-runs) saves it anew. */
  readonly savedAt: Record<string, { createdAt: string; updatedAt: string }>;
}

const NO_FILTERS = {
  concepts: [],
  genres: [],
  depths: [],
  relevances: [],
  authorships: [],
  topics: [],
};

/** A minute of the frames' day, oldest first (the list is newest first). */
const at = (minute: number): string =>
  new Date(Date.now() - (60 - minute) * 60_000).toISOString();

function conversationsOf(): Record<string, unknown>[] {
  const search = (topic: string, title: string, minute: number) => ({
    kind: 'search',
    id: randomUUID(),
    topic,
    title,
    createdAt: at(minute),
    updatedAt: at(minute),
    asks: [{ question: title, mode: 'all', filters: NO_FILTERS, total: null }],
  });
  const research = (
    title: string,
    minute: number,
    turn: Record<string, unknown>,
  ) => ({
    kind: 'research',
    id: randomUUID(),
    topic: HERMETISMO,
    title,
    createdAt: at(minute),
    updatedAt: at(minute),
    turns: [
      {
        id: randomUUID(),
        question: title,
        answer: '',
        sources: [],
        steps: 0,
        usd: 0,
        billing: 'per-token',
        model: 'stub/model',
        interrupted: false,
        profile: 'fast',
        at: at(minute),
        ...turn,
      },
    ],
  });
  return [
    search('alquimia', CONVERSATIONS.alchemy, 1),
    search(HERMETISMO, CONVERSATIONS.search, 2),
    research(CONVERSATIONS.sweep, 3, {
      answer:
        'Lista parcial: “A Lei do Ritmo” e “Ritmo, lição 01” citam obras de referência.',
      steps: 3,
      profile: 'exhaustive',
      coverage: {
        target: {},
        phrases: [],
        documents: 22,
        scanned: 22,
        withHits: null,
        read: 10,
        needed: 22,
        missing: 12,
        batches: 3,
        reason: 'requests',
      },
      sweep: {
        plan: { target: {}, extract: 'obras citadas como referência' },
        totals: {
          documents: 22,
          scanned: 22,
          withHits: null,
          read: 10,
          batches: 3,
        },
        findings: [],
      },
    }),
    research(CONVERSATIONS.interrupted, 4, {
      answer: 'Segundo o acervo, a natureza humana é descrita em sete planos',
      steps: 2,
      interrupted: true,
    }),
    research(CONVERSATIONS.failed, 5, {
      status: 'failed',
      error: 'LLM_UNAVAILABLE',
    }),
  ];
}

async function topicsOf(
  api: APIRequestContext,
): Promise<{ slug: string; title: string }[]> {
  const listed = await api.get('/api/v1/topics');
  return ((await listed.json()) as { items: { slug: string; title: string }[] })
    .items;
}

async function conversationIds(
  api: APIRequestContext,
): Promise<Record<string, string>> {
  const listed = await api.get('/api/v1/conversations');
  const { items } = (await listed.json()) as {
    items: { id: string; title: string }[];
  };
  return Object.fromEntries(items.map((one) => [one.title, one.id]));
}

async function conversationTimes(
  api: APIRequestContext,
): Promise<Record<string, { createdAt: string; updatedAt: string }>> {
  const listed = await api.get('/api/v1/conversations');
  const { items } = (await listed.json()) as {
    items: { title: string; createdAt: string; updatedAt: string }[];
  };
  return Object.fromEntries(
    [...items]
      .reverse()
      .map((one) => [
        one.title,
        { createdAt: one.createdAt, updatedAt: one.updatedAt },
      ]),
  );
}

async function personId(api: APIRequestContext, email: string) {
  const listed = await api.get('/api/v1/people');
  const body = (await listed.json()) as {
    items: { id: string; email: string }[];
  };
  return body.items.find((one) => one.email === email)?.id ?? '';
}

/** Signs a standalone context in as `email`, with the name Google would give. */
async function signInNamed(
  api: APIRequestContext,
  email: string,
  name: string,
): Promise<void> {
  const token = await api.post('/api/e2e/token', {
    data: { email, name },
    headers: CSRF,
  });
  const { credential } = (await token.json()) as { credential: string };
  const response = await api.post('/api/v1/auth/google', {
    data: { credential },
    headers: CSRF,
  });
  expect(response.status(), await response.text()).toBe(200);
}

let world: ChatWorld | null = null;
/** Once per worker; seeds a fresh server (tools/inventory/servers.sh start), else finds it. */
export async function seedChatWorld(): Promise<ChatWorld> {
  if (world) return world;
  const owner = await ownerApi();
  let topics = await topicsOf(owner);
  if (!topics.some((one) => one.title === CABALA)) {
    for (const title of [CABALA, COSMOLOGIA]) {
      const made = await owner.post('/api/v1/topics', {
        headers: CSRF,
        data: { title },
      });
      expect(made.status(), await made.text()).toBe(201);
    }
    for (const conversation of conversationsOf()) {
      const put = await owner.put(
        `/api/v1/conversations/${String(conversation['id'])}`,
        { data: conversation, headers: CSRF },
      );
      expect(put.status(), await put.text()).toBe(200);
    }
    topics = await topicsOf(owner);
    const slugOf = (title: string) =>
      topics.find((one) => one.title === title)?.slug ?? '';
    const grant = {
      topics: [HERMETISMO, slugOf(CABALA), slugOf(COSMOLOGIA)],
      features: ['search', 'research'],
    };
    await invite(owner, ANA.email, grant);
    // Ana Lima's own conversations: the same three, seen while the owner acts as her.
    const ana = await request.newContext({ baseURL: WEB_ORIGIN });
    await signInNamed(ana, ANA.email, ANA.name);
    for (const conversation of conversationsOf()) {
      const put = await ana.put(
        `/api/v1/conversations/${String(conversation['id'])}`,
        { data: conversation, headers: CSRF },
      );
      expect(put.status(), await put.text()).toBe(200);
    }
    await ana.dispose();
    await invite(owner, NO_TOPICS, { features: ['search', 'research'] });
  }
  const slugOf = (title: string) =>
    topics.find((one) => one.title === title)?.slug ?? '';
  world = {
    cabala: slugOf(CABALA),
    cosmologia: slugOf(COSMOLOGIA),
    anaId: await personId(owner, ANA.email),
    conversations: await conversationIds(owner),
    savedAt: await conversationTimes(owner),
  };
  await owner.dispose();
  return world;
}

/** LibraryRecents' key: FNV-1a of the address (apps/web/src/app/features/shell/library-recents.ts). */
function recentsKey(email: string): string {
  let hash = 0x811c9dc5;
  for (const char of email.toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `kb-chat.library-recents:${(hash >>> 0).toString(36)}`;
}

export interface ChatOptions {
  /** Who signs in (the recent collections are kept per address). */
  readonly email?: string;
  /** "Buscar documentos" or "Pesquisa com IA" on the home (remembered in kb-chat.view). */
  readonly view?: 'search' | 'research';
  /** What GET /api/v1/topics answers: the frames' list, an error, none, Hermetismo empty. */
  readonly topics?: 'frames' | 'error' | 'none' | 'empty-hermetismo';
  /** The conversations "Sua biblioteca" lists (by title). */
  readonly listed?: readonly string[];
  /** Who has no conversations of their own sees the owner's (the member with no collection). */
  readonly ownersList?: boolean;
  /** Whose recent collections are set (Ana Lima's, when the owner acts as her). */
  readonly recentsOf?: string;
}

/** The response patches listed in the header, and the browser's remembered choices. */
export async function chatWorld(
  context: BrowserContext,
  w: ChatWorld,
  options: ChatOptions = {},
): Promise<void> {
  const email = options.recentsOf ?? options.email ?? OWNER;
  const view = options.view ?? 'search';
  const topics = options.topics ?? 'frames';
  const listed = new Set<string>(options.listed ?? LISTED);
  const now = Date.now();
  const recents = {
    collections: {
      [HERMETISMO]: now - 60_000,
      [w.cabala]: now - 120_000,
      [w.cosmologia]: now - 180_000,
    },
    documents: [],
  };
  await context.addInitScript(
    ([key, value, chosen]) => {
      try {
        if (!localStorage.getItem(key)) localStorage.setItem(key, value);
        localStorage.setItem('kb-chat.view', chosen);
      } catch {
        // No storage: the list keeps the server's order.
      }
    },
    [recentsKey(email), JSON.stringify(recents), view] as const,
  );
  await context.route(/\/api\/v1\/topics(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (topics === 'error')
      return route.fulfill({
        status: 500,
        json: { error: { code: 'INTERNAL', message: 'down' } },
      });
    const response = await route.fetch();
    const body = (await response.json()) as {
      items: Record<string, unknown>[];
    };
    body.items =
      topics === 'none'
        ? []
        : body.items
            .filter(
              (topic) =>
                !String(topic['slug']).startsWith('zz-') &&
                topic['slug'] !== 'alquimia',
            )
            .map((topic) => {
              const title = String(topic['title']);
              if (topics === 'empty-hermetismo' && topic['slug'] === HERMETISMO)
                return { ...topic, documentCount: 0 };
              return title in COUNTS
                ? { ...topic, documentCount: COUNTS[title] }
                : topic;
            });
    await route.fulfill({ response, json: body });
  });
  let ownersList: unknown = null;
  if (options.ownersList) {
    const owner = await ownerApi();
    ownersList = await (await owner.get('/api/v1/conversations')).json();
    await owner.dispose();
  }
  await context.route(/\/api\/v1\/conversations(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (ownersList ?? (await response.json())) as {
      items: Listed[];
    };
    await route.fulfill({
      response,
      json: { ...body, items: framesList(body.items, listed, w.savedAt) },
    });
  });
}

type Listed = { title: string; createdAt?: string; updatedAt?: string };

/**
 * The frames' conversations, each once and at its seeded time: a state that asks or opens one
 * of them again (chat-results opens "lei do ritmo") saves it anew, or a new one of the same
 * title, which is the one open. It keeps the seeded one's place and time, so the list reads as
 * the frames draw it.
 */
function framesList<T extends Listed>(
  items: T[],
  listed: Set<string>,
  savedAt: ChatWorld['savedAt'],
): T[] {
  const kept = items.filter((one) => listed.has(one.title));
  const byTitle = new Map<string, T[]>();
  for (const one of kept)
    byTitle.set(one.title, [...(byTitle.get(one.title) ?? []), one]);
  const out: T[] = [];
  for (const one of kept) {
    const same = byTitle.get(one.title) ?? [one];
    const oldest = same[same.length - 1] ?? one;
    if (one !== oldest) continue;
    const newest = same[0] ?? one;
    const times = savedAt[one.title] ?? {
      createdAt: oldest.createdAt,
      updatedAt: oldest.updatedAt,
    };
    out.push({ ...newest, ...times });
  }
  // newest first, as the server lists them
  return out.sort((a, b) =>
    String(b.updatedAt).localeCompare(String(a.updatedAt)),
  );
}
