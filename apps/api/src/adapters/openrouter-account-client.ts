import type { FreeUsage } from '@kb-chat/contracts';
import { z } from 'zod';
import { LlmKeyRejectedError } from '../ports/llm-errors.js';
import type {
  OpenRouterAccountPort,
  OpenRouterModel,
  ProvisionedKey,
} from '../ports/openrouter-account.js';

export const OPENROUTER_API = 'https://openrouter.ai/api/v1';
const TIMEOUT_MS = 8_000;

const modelsSchema = z.object({
  data: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string().optional(),
      context_length: z.number().nullish(),
      pricing: z
        .looseObject({ prompt: z.string(), completion: z.string() })
        .optional(),
      supported_parameters: z.array(z.string()).nullish(),
    }),
  ),
});

const keyInfoSchema = z.object({
  data: z.looseObject({
    free_model_daily_requests: z
      .object({ used: z.number(), limit: z.number(), remaining: z.number() })
      .nullish(),
  }),
});

const exchangeSchema = z.looseObject({ key: z.string().min(8) });
const createdSchema = z.looseObject({
  key: z.string().min(8),
  data: z.looseObject({ hash: z.string().min(1) }),
});

const whole = (value: number): number => Math.max(0, Math.round(value));

/** OpenRouter's account endpoints over HTTP (a fake in tests and E2E, ADR 0016). */
export class OpenRouterAccountClient implements OpenRouterAccountPort {
  private readonly fetch: typeof fetch;

  constructor(options: { readonly fetch?: typeof fetch } = {}) {
    this.fetch = options.fetch ?? fetch;
  }

  async models(): Promise<readonly OpenRouterModel[]> {
    const body = await this.json(await this.call('/models', {}));
    return modelsSchema.parse(body).data.map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      contextLength: model.context_length ?? null,
      tools: (model.supported_parameters ?? []).includes('tools'),
      price: {
        input: Number(model.pricing?.prompt ?? 0) || 0,
        output: Number(model.pricing?.completion ?? 0) || 0,
      },
    }));
  }

  async freeUsage(key: string): Promise<FreeUsage | null> {
    const response = await this.call('/key', { key });
    if (response.status === 401 || response.status === 403)
      throw new LlmKeyRejectedError('OpenRouter', response.status);
    const usage = keyInfoSchema.parse(await this.json(response)).data
      .free_model_daily_requests;
    if (!usage) return null;
    return {
      used: whole(usage.used),
      limit: whole(usage.limit),
      remaining: whole(usage.remaining),
    };
  }

  async exchangeCode(code: string, verifier: string): Promise<string> {
    const response = await this.call('/auth/keys', {
      method: 'POST',
      body: { code, code_verifier: verifier, code_challenge_method: 'S256' },
    });
    return exchangeSchema.parse(await this.json(response)).key;
  }

  async createKey(
    managementKey: string,
    request: { name: string; limitUsd: number },
  ): Promise<ProvisionedKey> {
    const response = await this.call('/keys', {
      method: 'POST',
      key: managementKey,
      body: {
        name: request.name,
        limit: request.limitUsd,
        limit_reset: 'monthly',
      },
    });
    const created = createdSchema.parse(await this.json(response));
    return { hash: created.data.hash, key: created.key };
  }

  async updateKeyLimit(
    managementKey: string,
    change: { hash: string; limitUsd: number },
  ): Promise<void> {
    const path = `/keys/${encodeURIComponent(change.hash)}`;
    await this.json(
      await this.call(path, {
        method: 'PATCH',
        key: managementKey,
        body: { limit: change.limitUsd, limit_reset: 'monthly' },
      }),
    );
  }

  async deleteKey(managementKey: string, hash: string): Promise<void> {
    const path = `/keys/${encodeURIComponent(hash)}`;
    const response = await this.call(path, {
      method: 'DELETE',
      key: managementKey,
    });
    // Already gone is what we wanted.
    if (!response.ok && response.status !== 404)
      throw new Error(`OpenRouter answered ${response.status}`);
  }

  private call(
    path: string,
    request: { method?: string; key?: string; body?: object },
  ): Promise<Response> {
    const headers: Record<string, string> = { 'x-title': 'Nova Alexandria' };
    if (request.key) headers['authorization'] = `Bearer ${request.key}`;
    if (request.body) headers['content-type'] = 'application/json';
    return this.fetch(`${OPENROUTER_API}${path}`, {
      method: request.method ?? 'GET',
      headers,
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  }

  /** The body of a successful answer; a failure never carries its body (it may echo a key). */
  private async json(response: Response): Promise<unknown> {
    if (!response.ok) throw new Error(`OpenRouter answered ${response.status}`);
    return response.json();
  }
}
