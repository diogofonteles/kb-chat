import { createHash, randomUUID } from 'node:crypto';

/** A model of the fake's public list, in OpenRouter's wire shape. */
export interface FakeModel {
  readonly id: string;
  readonly name?: string;
  readonly context_length?: number;
  readonly pricing: { readonly prompt: string; readonly completion: string };
  readonly supported_parameters?: readonly string[];
}

export const FAKE_FREE_MODELS: readonly FakeModel[] = [
  {
    id: 'fake/large:free',
    name: 'Fake Large (free)',
    context_length: 131072,
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: ['tools', 'max_tokens'],
  },
  {
    id: 'fake/small:free',
    name: 'Fake Small (free)',
    context_length: 32768,
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: ['tools'],
  },
  {
    id: 'fake/chat-only:free',
    name: 'Fake chat only (free)',
    context_length: 65536,
    pricing: { prompt: '0', completion: '0' },
    supported_parameters: ['max_tokens'],
  },
  {
    id: 'fake/paid',
    name: 'Fake Paid',
    context_length: 200000,
    pricing: { prompt: '0.000001', completion: '0.000002' },
    supported_parameters: ['tools'],
  },
];

/**
 * A scripted chat answer (KBC-067): an HTTP failure, or the text built from the request's
 * body with the cost OpenRouter would report.
 */
export type FakeChatScript =
  | { readonly status: number }
  | ((body: FakeChatBody) => {
      readonly content: string;
      readonly cost?: number;
    });

/** A chat request as the fake received it. */
export interface FakeChatBody {
  readonly messages?: readonly { role: string; content: unknown }[];
  readonly [field: string]: unknown;
}

interface ChatCall {
  readonly models: readonly string[];
  readonly authorization: string | null;
}

const sse = (lines: readonly string[]): Response =>
  new Response(`${lines.map((line) => `data: ${line}`).join('\n\n')}\n\n`, {
    headers: { 'content-type': 'text/event-stream' },
  });

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

/**
 * OpenRouter without the network (KBC-022 NFR-2): the model list, `GET /key`, the OAuth code
 * exchange, key management and chat completions with the `models` fallback. Tests and the
 * E2E server read what it received.
 */
export class FakeOpenRouter {
  models: readonly FakeModel[] = FAKE_FREE_MODELS;
  freeRemaining = 1000;
  /** Models that answer 429, as if their free capacity ran out. */
  readonly busy = new Set<string>();
  readonly chats: ChatCall[] = [];
  /** Every chat request body, as sent. */
  readonly chatBodies: FakeChatBody[] = [];
  /** Answers used in order before the default one. */
  readonly scripted: FakeChatScript[] = [];
  readonly createdKeys = new Map<string, { key: string; limit: number }>();
  /** Key management answers 500 (to test what happens when OpenRouter fails). */
  failManagement = false;
  /** Runs before key management answers (a write slipping in while the house follows an AI). */
  beforeManagement: (() => Promise<void>) | null = null;
  private readonly validKeys = new Set<string>(['sk-or-v1-house-valid']);
  private readonly codes = new Map<
    string,
    { challenge: string; key: string }
  >();

  /** What the consent page does after "Authorize": a one-time code for this challenge. */
  authorize(challenge: string, key = `sk-or-v1-${randomUUID()}`): string {
    const code = randomUUID();
    this.codes.set(code, { challenge, key });
    this.validKeys.add(key);
    return code;
  }

  acceptKey(key: string): void {
    this.validKeys.add(key);
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const auth = new Headers(init?.headers).get('authorization');
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : null;
    const route = `${method} ${url.pathname.replace(/^\/api\/v1/, '')}`;
    if (route === 'GET /models') return json({ data: this.models });
    if (route === 'GET /key') return this.keyInfo(auth);
    if (route === 'POST /auth/keys') return this.exchange(body);
    if (route === 'POST /chat/completions') return this.chat(auth, body);
    if (url.pathname.includes('/keys')) {
      const before = this.beforeManagement;
      this.beforeManagement = null;
      await before?.();
      return this.manage(route, body);
    }
    return json({ error: { message: 'not found' } }, 404);
  };

  /** Any key ending in "valid" is accepted too (the E2E convention of KBC-007). */
  acceptValidSuffix = false;

  private isValid(auth: string | null): boolean {
    const key = auth?.replace(/^Bearer /, '') ?? '';
    return (
      this.validKeys.has(key) ||
      (this.acceptValidSuffix && key.endsWith('valid'))
    );
  }

  private keyInfo(auth: string | null): Response {
    if (!this.isValid(auth)) return json({ error: { code: 401 } }, 401);
    const used = 1000 - this.freeRemaining;
    return json({
      data: {
        free_model_daily_requests: {
          used,
          limit: 1000,
          remaining: this.freeRemaining,
        },
      },
    });
  }

  private exchange(body: unknown): Response {
    const { code, code_verifier } = (body ?? {}) as Record<string, string>;
    const issued = this.codes.get(code ?? '');
    const challenge = createHash('sha256')
      .update(code_verifier ?? '')
      .digest('base64url');
    if (!issued || issued.challenge !== challenge)
      return json({ error: { message: 'Invalid code or code_verifier' } }, 403);
    this.codes.delete(code ?? '');
    return json({ key: issued.key, user_id: 'user-1' });
  }

  private manage(route: string, body: unknown): Response {
    if (this.failManagement) return json({ error: { code: 500 } }, 500);
    const { limit, name } = (body ?? {}) as { limit?: number; name?: string };
    if (route === 'POST /keys') {
      const hash = `hash-${this.createdKeys.size + 1}`;
      const key = `sk-or-v1-person-${hash}`;
      this.createdKeys.set(hash, { key, limit: limit ?? 0 });
      this.validKeys.add(key);
      return json({ key, data: { hash, name } });
    }
    const hash = route.split('/').pop() ?? '';
    const found = this.createdKeys.get(hash);
    if (!found) return json({}, 404);
    if (route.startsWith('DELETE')) this.createdKeys.delete(hash);
    else this.createdKeys.set(hash, { ...found, limit: limit ?? found.limit });
    return json({ data: { hash } });
  }

  /** Records the body; the next scripted answer when there is one. */
  private scriptedFor(
    body: unknown,
    chain: readonly string[],
  ): Response | null {
    const sent = (body ?? {}) as FakeChatBody;
    this.chatBodies.push(sent);
    const script = this.scripted.shift();
    return script ? scriptedReply(script, sent, chain) : null;
  }

  private chat(auth: string | null, body: unknown): Response {
    if (!this.isValid(auth)) return json({ error: { code: 401 } }, 401);
    const { models = [], model } = (body ?? {}) as {
      models?: string[];
      model?: string;
    };
    const chain = models.length > 0 ? models : model ? [model] : [];
    this.chats.push({ models: chain, authorization: auth });
    const scripted = this.scriptedFor(body, chain);
    return scripted ?? this.houseReply(chain);
  }

  /** The default answer: the first model of the chain that is not busy. */
  private houseReply(chain: readonly string[]): Response {
    const served = chain.find((id) => !this.busy.has(id));
    if (!served)
      return json(
        { error: { code: 429, message: 'Rate limit exceeded' } },
        429,
      );
    const paid = !served.endsWith(':free') && served !== 'openrouter/free';
    const cost = paid ? 0.0004 : 0;
    return sse([
      JSON.stringify({
        model: served,
        choices: [{ delta: { content: 'Resposta do plano da casa.' } }],
      }),
      JSON.stringify({
        model: served,
        choices: [],
        usage: { prompt_tokens: 120, completion_tokens: 8, cost },
      }),
      '[DONE]',
    ]);
  }
}

function scriptedReply(
  script: FakeChatScript,
  body: FakeChatBody,
  chain: readonly string[],
): Response {
  if (typeof script !== 'function')
    return json({ error: { code: script.status } }, script.status);
  const { content, cost = 0 } = script(body);
  const model = chain[0] ?? 'openrouter';
  return sse([
    JSON.stringify({ model, choices: [{ delta: { content } }] }),
    JSON.stringify({
      model,
      choices: [],
      usage: { prompt_tokens: 1000, completion_tokens: 100, cost },
    }),
    '[DONE]',
  ]);
}
