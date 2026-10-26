import type { FreeUsage } from '@kb-chat/contracts';

/** A model of OpenRouter's public list, as the house needs it (KBC-022). */
export interface OpenRouterModel {
  readonly id: string;
  readonly name: string;
  readonly contextLength: number | null;
  /** `supported_parameters` includes `tools`: the research agent can use it. */
  readonly tools: boolean;
  /** US$ per token. */
  readonly price: { readonly input: number; readonly output: number };
}

/** A key created for one person with a monthly credit limit (management key). */
export interface ProvisionedKey {
  readonly hash: string;
  readonly key: string;
}

/** OpenRouter's account APIs besides chat (ADR 0016): models, key info, OAuth, management. */
export interface OpenRouterAccountPort {
  models(): Promise<readonly OpenRouterModel[]>;
  /** Today's free requests of a key; throws LlmKeyRejectedError on a refused key. */
  freeUsage(key: string): Promise<FreeUsage | null>;
  /** OAuth PKCE: the code and verifier for a user-controlled key. */
  exchangeCode(code: string, verifier: string): Promise<string>;
  createKey(
    managementKey: string,
    request: { readonly name: string; readonly limitUsd: number },
  ): Promise<ProvisionedKey>;
  updateKeyLimit(
    managementKey: string,
    change: { readonly hash: string; readonly limitUsd: number },
  ): Promise<void>;
  deleteKey(managementKey: string, hash: string): Promise<void>;
}
