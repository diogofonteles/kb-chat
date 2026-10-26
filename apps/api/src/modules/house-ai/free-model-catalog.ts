import { OPENROUTER_FREE_ROUTER, type FreeModelList } from '@kb-chat/contracts';
import type {
  OpenRouterAccountPort,
  OpenRouterModel,
} from '../../ports/openrouter-account.js';

/** The live list is refreshed once a day (KBC-022 FR-3). */
export const FREE_MODELS_TTL_MS = 24 * 60 * 60_000;
/** A failed refresh is retried after this, not on every request. */
const RETRY_MS = 5 * 60_000;
/** How many free models the automatic chain takes. */
export const AUTO_CHAIN_SIZE = 5;

const isFreeWithTools = (model: OpenRouterModel): boolean =>
  model.id.endsWith(':free') && model.tools;

const byContext = (a: OpenRouterModel, b: OpenRouterModel): number =>
  (b.contextLength ?? 0) - (a.contextLength ?? 0) || a.id.localeCompare(b.id);

export interface FreeModelCatalogDeps {
  readonly account: OpenRouterAccountPort;
  readonly now?: () => number;
  readonly warn?: (message: string) => void;
}

/**
 * OpenRouter's models, live (ADR 0016): the free ones with tool calling for the house chain,
 * and every price for the paid fallback's estimate. Never a hard-coded list.
 */
export class FreeModelCatalog {
  private models: readonly OpenRouterModel[] = [];
  private loadedAt: number | null = null;
  private failedAt: number | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly deps: FreeModelCatalogDeps) {}

  /** The free list, refreshed first when it is a day old. */
  async list(): Promise<FreeModelList> {
    await this.refreshIfStale();
    return this.view();
  }

  /** What is in memory now (the chain is built synchronously per call). */
  free(): readonly OpenRouterModel[] {
    void this.refreshIfStale().catch(() => undefined);
    return this.models.filter(isFreeWithTools).sort(byContext);
  }

  /** A model's price per token, from the same list (paid fallback estimate). */
  priceOf(id: string): OpenRouterModel['price'] | null {
    return this.models.find((model) => model.id === id)?.price ?? null;
  }

  /** The automatic chain: the first free models with tools, then the router when wanted. */
  autoChain(includeRouter: boolean): string[] {
    const ids = this.free()
      .slice(0, AUTO_CHAIN_SIZE)
      .map((model) => model.id);
    return includeRouter ? [...ids, OPENROUTER_FREE_ROUTER] : ids;
  }

  private view(): FreeModelList {
    const items = this.models
      .filter(isFreeWithTools)
      .sort(byContext)
      .map(({ id, name, contextLength }) => ({ id, name, contextLength }));
    const updatedAt =
      this.loadedAt === null ? null : new Date(this.loadedAt).toISOString();
    return { items, updatedAt, stale: this.failedAt !== null };
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private isStale(): boolean {
    const now = this.now();
    if (this.failedAt !== null && now - this.failedAt < RETRY_MS) return false;
    return this.loadedAt === null || now - this.loadedAt >= FREE_MODELS_TTL_MS;
  }

  private refreshIfStale(): Promise<void> {
    if (!this.isStale()) return Promise.resolve();
    this.loading ??= this.refresh().finally(() => {
      this.loading = null;
    });
    return this.loading;
  }

  private async refresh(): Promise<void> {
    try {
      this.models = await this.deps.account.models();
      this.loadedAt = this.now();
      this.failedAt = null;
    } catch (err) {
      // Keep the last list: the house keeps answering with it.
      this.failedAt = this.now();
      this.deps.warn?.(
        `OpenRouter model list refresh failed: ${err instanceof Error ? err.message : 'unknown'}`,
      );
    }
  }
}
