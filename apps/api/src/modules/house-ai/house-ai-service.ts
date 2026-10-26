import {
  OPENROUTER_FREE_ROUTER,
  type AiTestResult,
  type AppAi,
  type FreeUsage,
  type HouseAiUpdate,
  type HouseAiView,
  type PersonAi,
} from '@kb-chat/contracts';
import { AppError } from '../../app-error.js';
import type { DocumentStorePort } from '../../ports/document-store.js';
import { LlmKeyRejectedError } from '../../ports/llm-errors.js';
import type { OpenRouterAccountPort } from '../../ports/openrouter-account.js';
import type { SecretSealerPort } from '../../ports/secret-sealer.js';
import type { FreeModelCatalog } from './free-model-catalog.js';
import {
  DEFAULT_HOUSE_CONFIG,
  houseConfigSchema,
  type HouseConfig,
} from './house-config.js';

/** The free-request counter is read at most this often (one call per research otherwise). */
export const FREE_USAGE_TTL_MS = 60_000;

export interface HouseAiServiceDeps {
  readonly store: DocumentStorePort;
  readonly sealer: SecretSealerPort;
  readonly account: OpenRouterAccountPort;
  readonly catalog: FreeModelCatalog;
  readonly now?: () => Date;
  readonly warn?: (message: string) => void;
}

/** Whose key a provisioning call makes: the person's id and e-mail (the key's name). */
export interface KeyHolder {
  readonly id: string;
  readonly email: string;
}

const last4 = (key: string): string => key.slice(-4);

/**
 * The app's own AI (KBC-022, ADR 0016): the house OpenRouter account, its model chain, the
 * default app AI and quota, and the keys provisioned per person. Kept in memory, written to
 * house-ai.json with every key sealed.
 */
export class HouseAiService {
  private config: HouseConfig = DEFAULT_HOUSE_CONFIG;
  private writing: Promise<unknown> = Promise.resolve();
  private usage: { value: FreeUsage | null; at: number } | null = null;

  constructor(private readonly deps: HouseAiServiceDeps) {}

  async load(): Promise<void> {
    const raw = await this.deps.store.read();
    const parsed = houseConfigSchema.safeParse(raw ?? {});
    if (!parsed.success) this.deps.warn?.('house-ai.json is invalid; ignored');
    this.config = parsed.success ? parsed.data : DEFAULT_HOUSE_CONFIG;
  }

  isConnected(): boolean {
    return this.houseKey() !== null;
  }

  /** The house key, opened; null when not connected or not readable with this master key. */
  houseKey(): string | null {
    return this.openKey(this.config.connection?.key);
  }

  /** The key a person's house requests use: their provisioned one, else the house's. */
  keyFor(personId: string | null): string | null {
    const own = personId ? this.config.personKeys[personId] : undefined;
    return this.openKey(own?.key) ?? this.houseKey();
  }

  /** The free chain now: the master's list or the live one, then the router when wanted. */
  chain(): string[] {
    const { freeModels, includeRouter } = this.config;
    if (freeModels === null) return this.deps.catalog.autoChain(includeRouter);
    const chosen = freeModels.filter((id) => id !== OPENROUTER_FREE_ROUTER);
    return includeRouter ? [...chosen, OPENROUTER_FREE_ROUTER] : chosen;
  }

  paidModel(): string | null {
    return this.config.paidModel;
  }

  defaultAppAi(): AppAi {
    return this.config.defaultAppAi;
  }

  defaultDailyResearches(): number {
    return this.config.defaultDailyResearches;
  }

  /** Today's free requests of the house account (cached a minute); null when unknown. */
  async freeUsage(): Promise<FreeUsage | null> {
    const key = this.houseKey();
    if (!key) return null;
    const now = this.nowMs();
    if (this.usage && now - this.usage.at < FREE_USAGE_TTL_MS)
      return this.usage.value;
    const value = await this.deps.account.freeUsage(key).catch(() => null);
    this.usage = { value, at: now };
    return value;
  }

  /** The live list in memory first, so the chain is the real one. */
  async ready(): Promise<void> {
    await this.deps.catalog.list();
  }

  async view(): Promise<HouseAiView> {
    await this.ready();
    const { connection, managementKey, ...rest } = this.config;
    return {
      connection: connection && {
        key: { set: true, last4: connection.last4 },
        via: connection.via,
        connectedAt: connection.connectedAt,
        connectedBy: connection.connectedBy,
      },
      freeModels: rest.freeModels,
      includeRouter: rest.includeRouter,
      chain: this.chain(),
      paidModel: rest.paidModel,
      defaultAppAi: rest.defaultAppAi,
      defaultDailyResearches: rest.defaultDailyResearches,
      managementKey: managementKey && { set: true, last4: managementKey.last4 },
      freeUsage: await this.freeUsage(),
    };
  }

  /** A master's change; a typed key connects the house account ("Colar uma chave"). */
  async update(patch: HouseAiUpdate, by: string): Promise<HouseAiView> {
    const { key, managementKey, ...rest } = patch;
    await this.change((config) => ({
      ...config,
      ...rest,
      ...(key !== undefined && { connection: this.connection(key, 'key', by) }),
      ...(managementKey !== undefined && {
        managementKey: this.sealedManagementKey(managementKey),
      }),
    }));
    return this.view();
  }

  /** The key from "Conectar OpenRouter" (OAuth PKCE). */
  async connect(key: string, by: string): Promise<void> {
    await this.change((config) => ({
      ...config,
      connection: this.connection(key, 'oauth', by),
    }));
  }

  async disconnect(): Promise<void> {
    await this.change((config) => ({ ...config, connection: null }));
  }

  /** "Testar conexão": the key info answers with the key accepted. */
  async test(): Promise<AiTestResult> {
    const started = this.nowMs();
    const key = this.houseKey();
    const result = (ok: boolean, code: AiTestResult['code']): AiTestResult => ({
      ok,
      code,
      model: 'openrouter',
      latencyMs: Math.max(0, this.nowMs() - started),
    });
    if (!key) return result(false, 'LLM_NOT_CONFIGURED');
    try {
      await this.deps.account.freeUsage(key);
      return result(true, null);
    } catch (err) {
      const code =
        err instanceof LlmKeyRejectedError
          ? 'LLM_KEY_REJECTED'
          : 'PROVIDER_UNAVAILABLE';
      return result(false, code);
    }
  }

  /** "Também para os próximos": the default app AI of people left on `default`. */
  async setDefault(appAi: AppAi): Promise<void> {
    await this.change((config) => ({ ...config, defaultAppAi: appAi }));
  }

  /**
   * Keeps OpenRouter's own limit in step with a person's paid fallback (ADR 0016): with a
   * management key, a key with a monthly limit while the fallback is on, none when off.
   */
  async beforePersonAiChange(holder: KeyHolder, next: PersonAi): Promise<void> {
    const management = this.openKey(this.config.managementKey?.key);
    if (!management) return;
    const current = this.config.personKeys[holder.id];
    const { enabled, monthlyCapUsd } = next.paidFallback;
    try {
      if (!enabled && current) await this.dropKey(management, holder.id);
      else if (enabled && !current)
        await this.provisionKey(management, holder, monthlyCapUsd);
      else if (enabled && current && current.limitUsd !== monthlyCapUsd)
        await this.limitKey(management, holder.id, monthlyCapUsd);
    } catch (err) {
      throw new AppError(
        'PROVIDER_UNAVAILABLE',
        'OpenRouter key management failed',
        {
          cause: err,
        },
      );
    }
  }

  private async provisionKey(
    management: string,
    holder: KeyHolder,
    limitUsd: number,
  ): Promise<void> {
    const created = await this.deps.account.createKey(management, {
      name: `Nova Alexandria — ${holder.email}`,
      limitUsd,
    });
    const stored = {
      hash: created.hash,
      key: this.deps.sealer.seal(created.key),
      limitUsd,
    };
    await this.change((config) => ({
      ...config,
      personKeys: { ...config.personKeys, [holder.id]: stored },
    }));
  }

  private async limitKey(
    management: string,
    personId: string,
    limitUsd: number,
  ): Promise<void> {
    const current = this.config.personKeys[personId];
    if (!current) return;
    await this.deps.account.updateKeyLimit(management, {
      hash: current.hash,
      limitUsd,
    });
    await this.change((config) => ({
      ...config,
      personKeys: {
        ...config.personKeys,
        [personId]: { ...current, limitUsd },
      },
    }));
  }

  private async dropKey(management: string, personId: string): Promise<void> {
    const current = this.config.personKeys[personId];
    if (!current) return;
    await this.deps.account.deleteKey(management, current.hash);
    await this.change((config) => {
      const kept = Object.entries(config.personKeys).filter(
        ([id]) => id !== personId,
      );
      return { ...config, personKeys: Object.fromEntries(kept) };
    });
  }

  private connection(key: string, via: 'oauth' | 'key', by: string) {
    this.usage = null;
    return {
      key: this.deps.sealer.seal(key),
      last4: last4(key),
      via,
      connectedAt: (this.deps.now?.() ?? new Date()).toISOString(),
      connectedBy: by,
    };
  }

  private sealedManagementKey(key: string | null) {
    return key === null
      ? null
      : { key: this.deps.sealer.seal(key), last4: last4(key) };
  }

  private openKey(sealed: string | undefined): string | null {
    if (!sealed) return null;
    try {
      return this.deps.sealer.open(sealed);
    } catch {
      return null;
    }
  }

  private nowMs(): number {
    return (this.deps.now?.() ?? new Date()).getTime();
  }

  /** Changes apply one after the other, each written before the next starts. */
  private change(apply: (config: HouseConfig) => HouseConfig): Promise<void> {
    const run = this.writing.then(async () => {
      const next = apply(this.config);
      await this.deps.store.write(next);
      this.config = next;
    });
    this.writing = run.catch(() => undefined);
    return run;
  }
}
