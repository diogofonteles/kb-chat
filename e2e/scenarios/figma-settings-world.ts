import { randomUUID } from 'node:crypto';
import { request } from '@playwright/test';
import type { APIRequestContext, BrowserContext } from '@playwright/test';
import {
  CSRF,
  OWNER_EMAIL,
  WEB_ORIGIN,
  codeSentTo,
  expect,
} from '../specs/fixtures.js';

/**
 * The sample data of the v2 · Configurações frames (settings-*, figma-recreation's
 * redesign/src/features/settings.*.js), seeded on a FRESH E2E server so the app shows what the
 * frames show. The E2E server's own: the owner ("Dono", stub model), Hermetismo (22 documents)
 * and Alquimia Prática, the fake OpenRouter's free models (fake/large:free, fake/small:free),
 * the Codex runner (logged in, off) and the Groq spend (US$ 0,00 de 10,00).
 *
 * Seeded for real, through the API: the house plan connected with a key ending in "valid"
 * ("••••alid"), the people of "Pessoas e permissões" in the frames' order (Ana Souza, Eduardo
 * Alves, carla.mendes invited, Rita Moraes, Caio Leitor, Lia Envia, Davi Lista, Helena Prado
 * master, Lucas Martins, Ana Lima, Nina Ouvinte), the invite profiles "Aluno" (default) and
 * "Pesquisador", the three access requests (Bruno Lima and Paulo Nunes by Google, Fernanda
 * Costa by the form), one "Ver como" of Ana Souza with one change and six of Ana Lima, and the
 * transcriber "Mac do estúdio"; the two conversations of "Sua biblioteca" (the research "O que
 * é a natureza sétupla?" and the search "Os sete planos em ordem") for the owner and Ana Souza.
 *
 * Patched in the responses (`settingsWorld`), each because no API can set it:
 * - the instants the server stamps (last sign-in, invitation, request, the audit's and the
 *   accesses' times) are the frames' 09/11 and 10/11/2026 ones, by person and in order;
 * - GET /api/v1/topics has the frames' collections only: the E2E server's "Zz …" level
 *   collections are left out, "Cosmologia Espiritual" (6) and "Cabala" (9) are added
 *   (documents come from the kb vault, which no API writes);
 * - GET /api/v1/spend/people has Helena Prado's US$ 0,01;
 * - GET /api/v1/media/terms is the frames' list (32 hermetic terms, version 1 of 28/10/2026,
 *   162 of 224): the server's own list is another collection's and a saved list is version 2;
 * - GET /api/v1/media/track-documents has Alquimia Prática's 11 tracks waiting for the Mac;
 * - GET /api/v1/house-ai's free list is "atualizada às 18:40";
 * - GET /api/v1/conversations dates the research now and the search yesterday ("agora",
 *   "ontem"), whenever the frame is taken.
 *
 * In the browser: "Sua biblioteca" in its "Recentes" order of the frames (Hermetismo, Cabala,
 * Cosmologia Espiritual), the order this browser keeps (LibraryRecents).
 */

export const OWNER = OWNER_EMAIL;
export const MAC = 'Mac do estúdio';

interface Person {
  readonly email: string;
  readonly name?: string;
  readonly topics?: readonly string[];
  readonly features?: readonly string[];
  readonly ai?: Record<string, unknown>;
  readonly role?: 'master';
  /** Invited with the e-mail sent, never signed in. */
  readonly invitedOnly?: boolean;
  /** The frame's "Último acesso" (or "Convite enviado em"), São Paulo time. */
  readonly at: string;
}

const HOUSE = { appAi: 'house' } as const;
const READER = ['search', 'research'] as const;
export const ANA_SOUZA = 'ana.souza@exemplo.test';
export const EDUARDO = 'eduardo.alves@exemplo.test';
export const ANA_LIMA = 'ana.lima@exemplo.test';
/** settings.1.js PEOPLE, in the frames' order. */
export const PEOPLE: readonly Person[] = [
  {
    email: ANA_SOUZA,
    name: 'Ana Souza',
    topics: ['hermetismo', 'alquimia'],
    features: [...READER, 'own-ai-settings'],
    ai: HOUSE,
    at: '2026-11-10T11:28',
  },
  {
    email: EDUARDO,
    name: 'Eduardo Alves',
    topics: ['hermetismo'],
    features: READER,
    ai: { ...HOUSE, dailyResearches: 5 },
    at: '2026-11-10T11:28',
  },
  {
    email: 'carla.mendes@exemplo.test',
    invitedOnly: true,
    at: '2026-11-09T18:58',
  },
  {
    email: 'rita.lista@kb-chat.test',
    name: 'Rita Moraes',
    topics: ['alquimia'],
    features: READER,
    ai: HOUSE,
    at: '2026-11-09T22:01',
  },
  {
    email: 'caio.leitor@kb-chat.test',
    name: 'Caio Leitor',
    topics: ['hermetismo'],
    features: READER,
    ai: HOUSE,
    at: '2026-11-09T22:00',
  },
  {
    email: 'lia.envia@kb-chat.test',
    name: 'Lia Envia',
    topics: ['hermetismo'],
    features: READER,
    ai: HOUSE,
    at: '2026-11-09T22:02',
  },
  {
    email: 'davi.lista@kb-chat.test',
    name: 'Davi Lista',
    topics: ['hermetismo'],
    features: READER,
    ai: HOUSE,
    at: '2026-11-09T22:01',
  },
  {
    email: 'helena.prado@exemplo.test',
    name: 'Helena Prado',
    role: 'master',
    // "IA: Nenhuma (IA própria ou só a busca)", chosen (not the default the owner has).
    ai: { appAi: 'none' },
    at: '2026-11-10T11:28',
  },
  {
    email: 'lucas.martins@exemplo.test',
    name: 'Lucas Martins',
    topics: [],
    features: READER,
    ai: HOUSE,
    at: '2026-11-10T11:27',
  },
  {
    email: ANA_LIMA,
    name: 'Ana Lima',
    topics: ['hermetismo'],
    features: READER,
    ai: HOUSE,
    at: '2026-11-10T11:28',
  },
  {
    email: 'nina.ouvinte@kb-chat.test',
    name: 'Nina Ouvinte',
    topics: ['alquimia'],
    features: READER,
    ai: HOUSE,
    at: '2026-11-09T22:02',
  },
];
const OWNER_AT = '2026-11-10T11:29';

const BRUNO = { email: 'bruno.lima@exemplo.test', name: 'Bruno Lima' };
const PAULO = { email: 'paulo.nunes@exemplo.test', name: 'Paulo Nunes' };
const FERNANDA = {
  email: 'fernanda.costa@exemplo.test',
  firstName: 'Fernanda',
  lastName: 'Costa',
  phone: '(81) 99999-0000',
};
/** settings.1.js REQS: when each asked. */
const REQUESTED_AT: Record<string, string> = {
  [BRUNO.email]: '2026-11-09T18:58',
  [FERNANDA.email]: '2026-11-09T18:58',
  [PAULO.email]: '2026-11-09T18:59',
};
export const ACT_AS_REASON = 'Conferir por que os marcadores não aparecem';
/** settings.1.js AUD: the six "Ver como" of Ana Lima, newest first, then Ana Souza's. */
const ANA_LIMA_STARTS = [
  '2026-11-10T11:28:43',
  '2026-11-09T21:59:41',
  '2026-11-09T19:38:57',
  '2026-11-09T19:29:40',
  '2026-11-09T19:06:13',
  '2026-11-09T19:01:35',
];
const ANA_SOUZA_AT = '2026-11-09T18:58:16';
/** When the house plan was given to each person, as the AI's history says it. */
const AI_CHANGED_AT = '2026-11-09T18:58';

/** São Paulo wall time (UTC−3) → ISO instant. */
const sp = (wall: string): string =>
  new Date(`${wall}${wall.length === 16 ? ':00' : ''}.000-03:00`).toISOString();

export const TERMS = [
  'Mestre Laércio',
  'Hermes Trismegisto',
  'Caibalion',
  'Tábua de Esmeralda',
  'Irmã Helena Prado',
  'Sephiroth',
  'Árvore da Vida',
  'Kether',
  'Malkuth',
  'Tiphereth',
  'Corpus Hermeticum',
  'Poimandres',
  'Alquimia Prática',
  'Cosmologia Espiritual',
  'natureza sétupla',
  'plano mental',
  'plano astral',
  'Lei do Ritmo',
  'Lei da Polaridade',
  'Lei de Correspondência',
  'Lei de Vibração',
  'Lei de Causa e Efeito',
  'Lei de Gênero',
  'Mentalismo',
  'Akasha',
  'Rosa-Cruz',
  'Paracelso',
  'Eliphas Lévi',
  'Papus',
  'Fama Fraternitatis',
  'Opus Magnum',
  'Sérgio Andrade',
];

async function ok(
  pending: Promise<{
    ok(): boolean;
    status(): number;
    text(): Promise<string>;
  }>,
  what: string,
) {
  const response = await pending;
  expect(
    response.ok(),
    `${what}: ${response.status()} ${await response.text()}`,
  ).toBe(true);
  return response;
}

/** The frames' names: every sign-in sends them (a sign-in without one names the account after its address). */
const NAMES: Record<string, string> = {
  [OWNER]: 'Dono',
  ...Object.fromEntries(
    PEOPLE.filter((one) => one.name).map((one) => [one.email, one.name ?? '']),
  ),
};

/** Signs `api` (a page's or a standalone request context) in as `email`, with its name. */
export async function signInNamed(
  api: APIRequestContext,
  email: string,
): Promise<void> {
  const name = NAMES[email];
  const token = await api.post('/api/e2e/token', {
    data: name ? { email, name } : { email },
    headers: CSRF,
  });
  const { credential } = (await token.json()) as { credential: string };
  await ok(
    api.post('/api/v1/auth/google', { data: { credential }, headers: CSRF }),
    `sign-in ${email}`,
  );
}

/** A request context signed in as `email`. */
export async function apiAs(email: string): Promise<APIRequestContext> {
  const api = await request.newContext({ baseURL: WEB_ORIGIN });
  await signInNamed(api, email);
  return api;
}

/** A Google sign-in nobody invited, turned into an access request. */
async function googleRequest(person: {
  email: string;
  name: string;
}): Promise<void> {
  const api = await request.newContext({ baseURL: WEB_ORIGIN });
  const token = await api.post('/api/e2e/token', {
    data: person,
    headers: CSRF,
  });
  const { credential } = (await token.json()) as { credential: string };
  const refused = await api.post('/api/v1/auth/google', {
    data: { credential },
    headers: CSRF,
  });
  expect(refused.status()).toBe(403);
  const { ticket } = (
    (await refused.json()) as { error: { details: { ticket: string } } }
  ).error.details;
  await ok(
    api.post('/api/v1/access-requests/google', {
      data: { ticket },
      headers: CSRF,
    }),
    `request ${person.email}`,
  );
  await api.dispose();
}

/** "Pedir acesso sem conta Google": the form, confirmed with the code sent. */
async function formRequest(): Promise<void> {
  const api = await request.newContext({ baseURL: WEB_ORIGIN });
  await ok(
    api.post('/api/v1/access-requests/signup', {
      data: FERNANDA,
      headers: CSRF,
    }),
    'signup',
  );
  const code = await codeSentTo(api, FERNANDA.email);
  await ok(
    api.post('/api/v1/access-requests/signup/verify', {
      data: { email: FERNANDA.email, code },
      headers: CSRF,
    }),
    'verify',
  );
  await api.dispose();
}

interface PersonRow {
  readonly id: string;
  readonly email: string;
}

export interface SettingsWorld {
  /** Person id by e-mail. */
  readonly ids: Record<string, string>;
}

async function peopleOf(owner: APIRequestContext): Promise<PersonRow[]> {
  return (
    (await (await owner.get('/api/v1/people')).json()) as {
      items: PersonRow[];
    }
  ).items;
}

let world: SettingsWorld | null = null;
/** Once per worker; seeds a fresh server (tools/inventory/servers.sh start), else finds it. */
export async function seedSettingsWorld(): Promise<SettingsWorld> {
  if (world) return world;
  const owner = await apiAs(OWNER);
  const known = await peopleOf(owner);
  if (known.some((one) => one.email === ANA_SOUZA)) {
    world = {
      ids: Object.fromEntries(known.map((one) => [one.email, one.id])),
    };
    await owner.dispose();
    return world;
  }

  await ok(
    owner.put('/api/v1/house-ai', {
      data: { key: 'sk-or-v1-house-valid' },
      headers: CSRF,
    }),
    'house',
  );
  // The owner's Preferências as the frames show them: "Acervo padrão · Hermetismo".
  await ok(
    owner.put('/api/v1/settings', {
      data: { preferences: { theme: 'auto', defaultTopic: 'hermetismo' } },
      headers: CSRF,
    }),
    'owner settings',
  );

  const ids: Record<string, string> = {};
  for (const person of PEOPLE) {
    const created = await owner.post('/api/v1/people', {
      data: { email: person.email, sendEmail: !!person.invitedOnly },
      headers: CSRF,
    });
    expect(created.status(), await created.text()).toBe(201);
    const { id } = (await created.json()) as { id: string };
    ids[person.email] = id;
    const grant: Record<string, unknown> = {};
    if (person.role) grant['role'] = person.role;
    if (person.topics) grant['topics'] = person.topics;
    if (person.features) grant['features'] = person.features;
    if (person.ai) grant['ai'] = person.ai;
    if (Object.keys(grant).length > 0)
      await ok(
        owner.patch(`/api/v1/people/${id}`, { data: grant, headers: CSRF }),
        `grant ${person.email}`,
      );
    if (person.invitedOnly) continue;
    // Signed in once: the name is known and the person is "Ativo"; the settings exist, so
    // the first-run wizard stays closed for them.
    const api = await apiAs(person.email);
    await ok(
      api.put('/api/v1/settings', {
        data: { preferences: { theme: 'auto' } },
        headers: CSRF,
      }),
      `settings ${person.email}`,
    );
    await api.dispose();
  }

  await ok(
    owner.post('/api/v1/invite-profiles', {
      data: {
        name: 'Aluno',
        isDefault: true,
        // The invitation configured from it (settings-people-invite-setup): both
        // collections, "Buscar documentos", "Pesquisa com IA", "Configurações de IA próprias".
        preset: {
          topics: ['hermetismo', 'alquimia'],
          features: [...READER, 'own-ai-settings'],
          ai: { appAi: 'house', dailyResearches: 5 },
          // Its "Preferências iniciais" (settings-invite-profile-edit).
          preferences: {
            defaultTopic: 'hermetismo',
            defaultView: 'research',
            researchProfile: 'fast',
            theme: 'revised',
          },
        },
      },
      headers: CSRF,
    }),
    'profile Aluno',
  );
  await ok(
    owner.post('/api/v1/invite-profiles', {
      data: {
        name: 'Pesquisador',
        isDefault: false,
        preset: {
          topics: ['hermetismo', 'alquimia'],
          features: [...READER, 'own-ai-settings'],
          ai: { appAi: 'house', dailyResearches: 20 },
        },
      },
      headers: CSRF,
    }),
    'profile Pesquisador',
  );

  await googleRequest(BRUNO);
  await formRequest();
  await googleRequest(PAULO);

  // Ana Souza's "Ver como", with one change (act-as.spec AC-8); then Ana Lima's six starts,
  // each left to expire on its own context.
  const acting = await apiAs(OWNER);
  await ok(
    acting.post(`/api/v1/people/${ids[ANA_SOUZA]}/act-as`, {
      data: { reason: ACT_AS_REASON },
      headers: CSRF,
    }),
    'act-as Ana Souza',
  );
  await ok(
    acting.put('/api/v1/settings', {
      data: { preferences: { theme: 'auto' } },
      headers: CSRF,
    }),
    'act-as change',
  );
  await ok(acting.delete('/api/v1/act-as', { headers: CSRF }), 'act-as stop');
  await acting.dispose();
  for (const at of ANA_LIMA_STARTS) {
    const again = await apiAs(OWNER);
    await ok(
      again.post(`/api/v1/people/${ids[ANA_LIMA]}/act-as`, {
        data: { reason: 'não vê os marcadores' },
        headers: CSRF,
      }),
      `act-as Ana Lima (the frame's ${at})`,
    );
    await again.dispose();
  }

  for (const email of [OWNER, ANA_SOUZA]) {
    const api = await apiAs(email);
    for (const chat of CHATS()) {
      await ok(
        api.put(`/api/v1/conversations/${String(chat['id'])}`, {
          data: chat,
          headers: CSRF,
        }),
        `conversation ${email}`,
      );
    }
    await api.dispose();
  }

  await ok(
    owner.post('/api/v1/media/transcribers', {
      data: { name: MAC },
      headers: CSRF,
    }),
    'pair',
  );
  await owner.dispose();
  world = { ids };
  return world;
}

/** "Sua biblioteca"'s two conversations (settings.*.js): a research and a search. */
const RESEARCH = 'O que é a natureza sétupla?';
const SEARCH = 'Os sete planos em ordem';
function CHATS(): Record<string, unknown>[] {
  const now = new Date().toISOString();
  return [
    {
      kind: 'search',
      id: randomUUID(),
      topic: 'hermetismo',
      title: SEARCH,
      createdAt: now,
      updatedAt: now,
      asks: [{ question: SEARCH, mode: 'all', filters: {}, total: 3 }],
    },
    {
      kind: 'research',
      id: randomUUID(),
      topic: 'hermetismo',
      title: RESEARCH,
      createdAt: now,
      updatedAt: now,
      turns: [
        {
          question: RESEARCH,
          answer: 'A natureza sétupla é a divisão do ser em sete planos.',
          sources: [],
          steps: 1,
          usd: 0.03,
          billing: 'per-token',
          model: 'stub',
          interrupted: false,
          at: now,
        },
      ],
    },
  ];
}

/** LibraryRecents' key for an account (its FNV-1a of the address, as the app keeps it). */
function recentsKey(email: string): string {
  let hash = 0x811c9dc5;
  for (const char of email.toLowerCase()) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `kb-chat.library-recents:${(hash >>> 0).toString(36)}`;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A GET answered with the server's body, changed by `edit`. */
async function patchGet(
  context: BrowserContext,
  url: string | RegExp,
  edit: (body: Record<string, unknown>) => unknown,
): Promise<void> {
  await context.route(url, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: edit(body) });
  });
}

/** Every ISO instant of `value` (a list item) mapped by `at`, recursively. */
function restamp(value: unknown, at: string): unknown {
  if (Array.isArray(value)) return value.map((one) => restamp(one, at));
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, one] of Object.entries(value))
    out[key] =
      typeof one === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(one)
        ? at
        : restamp(one, at);
  return out;
}

export interface SettingsOptions {
  /** IA da aplicação as before the first "Conectar OpenRouter" (settings-house-disconnected). */
  readonly houseDisconnected?: boolean;
  /** Groq connected, used only when asked (settings-groq-connected). */
  readonly groqConnected?: boolean;
  /** The first-run wizard: the browser sees a person without settings. */
  readonly firstRun?: boolean;
  /**
   * Without "Cosmologia Espiritual" and "Cabala" (only the server's collections): the phone's
   * people frames, which have no "Sua biblioteca" and whose editors list Alquimia Prática and
   * Hermetismo only.
   */
  readonly servedCollectionsOnly?: boolean;
}

/** The response patches listed in the header, on a browser context. */
export async function settingsWorld(
  context: BrowserContext,
  options: SettingsOptions = {},
): Promise<void> {
  const atOf = new Map<string, string>(
    PEOPLE.map((one) => [one.email, one.at]),
  );
  atOf.set(OWNER, OWNER_AT);
  await patchGet(context, /\/api\/v1\/people(\?.*)?$/, (body) => ({
    ...body,
    items: (body['items'] as Record<string, unknown>[]).map((person) => {
      const at = atOf.get(String(person['email']));
      const stamped = (at ? restamp(person, sp(at)) : person) as Record<
        string,
        unknown
      >;
      // The AI's history in the frames: the change of 09/11/2026 18:58 (settings-people-editor-ai).
      const ai = stamped['ai'];
      return isRecord(ai) && Array.isArray(ai['history'])
        ? {
            ...stamped,
            ai: { ...ai, history: restamp(ai['history'], sp(AI_CHANGED_AT)) },
          }
        : stamped;
    }),
  }));
  await patchGet(context, '**/api/v1/access-requests', (body) => ({
    ...body,
    items: (body['items'] as Record<string, unknown>[]).map((one) => {
      const at = REQUESTED_AT[String(one['email'])];
      return at ? restamp(one, sp(at)) : one;
    }),
  }));
  await patchGet(context, /\/api\/v1\/act-as\/audit(\?.*)?$/, (body) => {
    const items = body['items'] as Record<string, unknown>[];
    // Newest first: Ana Lima's six starts, then Ana Souza's end, change and start.
    let lima = 0;
    return {
      ...body,
      items: items.map((one) =>
        JSON.stringify(one).includes('Ana Lima') ||
        JSON.stringify(one).includes(ANA_LIMA)
          ? restamp(one, sp(ANA_LIMA_STARTS[lima++] ?? ANA_SOUZA_AT))
          : restamp(one, sp(ANA_SOUZA_AT)),
      ),
    };
  });
  await patchGet(context, '**/api/v1/me/accesses', (body) =>
    restamp(body, sp(ANA_SOUZA_AT)),
  );
  await patchGet(context, /\/api\/v1\/topics(\?.*)?$/, (body) => {
    const items = (body['items'] as Record<string, unknown>[]).filter(
      (topic) => !String(topic['slug']).startsWith('zz-'),
    );
    const extra = (slug: string, title: string, documentCount: number) => ({
      ...items[0],
      slug,
      title,
      documentCount,
      trackCount: 0,
      mainAuthor: null,
    });
    return {
      ...body,
      items: options.servedCollectionsOnly
        ? items
        : [
            ...items,
            extra('cosmologia-espiritual', 'Cosmologia Espiritual', 6),
            extra('cabala', 'Cabala', 9),
          ],
    };
  });
  await patchGet(context, '**/api/v1/spend/people', (body) => ({
    ...body,
    items: [
      ...(body['items'] as Record<string, unknown>[]).map((one) =>
        one['email'] === OWNER ? { ...one, usd: 0 } : one,
      ),
      { email: 'helena.prado@exemplo.test', usd: 0.01 },
    ],
  }));
  await patchGet(context, '**/api/v1/media/terms', (body) => ({
    ...body,
    tokens: 162,
    limit: 224,
    version: 1,
    terms: TERMS,
    createdAt: '2026-10-28T12:00:00.000Z',
    authorName: null,
    versions: [
      {
        version: 1,
        createdAt: '2026-10-28T12:00:00.000Z',
        authorName: null,
        termCount: TERMS.length,
      },
    ],
  }));
  await patchGet(context, '**/api/v1/media/track-documents', (body) => ({
    ...body,
    collections: [
      {
        topic: 'alquimia',
        title: 'Alquimia Prática',
        tracks: 11,
        toPublish: 0,
        queued: 11,
        published: 0,
        failed: 0,
      },
    ],
    queue: {
      ...(body['queue'] as Record<string, unknown>),
      waiting: 11,
    },
  }));
  await patchGet(context, '**/api/v1/house-ai', (body) => {
    const out = restamp(body, sp('2026-11-09T18:40')) as Record<
      string,
      unknown
    >;
    return options.houseDisconnected
      ? { ...out, connection: null, freeUsage: null, managementKey: null }
      : out;
  });
  // The free models' list "atualizada às 18:40" (its own endpoint).
  await patchGet(context, '**/api/v1/ai/free-models', (body) =>
    restamp(body, sp('2026-11-09T18:40')),
  );
  if (options.groqConnected)
    await patchGet(context, '**/api/v1/media/groq', (body) => ({
      ...body,
      connected: true,
      keyProblem: null,
      mode: 'manual',
    }));
  // The research "agora", the search "ontem", whenever the frame is taken.
  await patchGet(context, /\/api\/v1\/conversations(\?.*)?$/, (body) => {
    const now = Date.now();
    return {
      ...body,
      items: (
        (body['items'] as Record<string, unknown>[] | undefined) ?? []
      ).map((one) => {
        const at = new Date(
          one['title'] === SEARCH ? now - 24 * 3_600_000 : now,
        ).toISOString();
        return { ...one, createdAt: at, updatedAt: at };
      }),
    };
  });
  // "Sua biblioteca" in the frames' "Recentes" order: Hermetismo, Cabala, Cosmologia.
  const recents = JSON.stringify({
    collections: {
      hermetismo: 3_000,
      cabala: 2_000,
      'cosmologia-espiritual': 1_000,
    },
    documents: [],
  });
  await context.addInitScript(
    ([keys, value]) => {
      for (const key of keys as string[])
        if (!localStorage.getItem(key))
          localStorage.setItem(key, value as string);
    },
    [[OWNER, ANA_SOUZA, EDUARDO].map(recentsKey), recents] as const,
  );
  if (options.firstRun)
    await patchGet(context, '**/api/v1/settings', (body) => ({
      ...body,
      exists: false,
    }));
}
