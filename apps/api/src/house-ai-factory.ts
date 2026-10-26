import { join } from 'node:path';
import { JsonDocumentStore } from './adapters/json-document-store.js';
import {
  JsonlHouseUsage,
  MemoryHouseUsage,
} from './adapters/house-usage-ledgers.js';
import { JsonlSpendLedger } from './adapters/jsonl-spend-ledger.js';
import { MemoryDocumentStore } from './adapters/memory-document-store.js';
import { MemorySpendLedger } from './adapters/memory-spend-ledger.js';
import { OpenRouterAccountClient } from './adapters/openrouter-account-client.js';
import {
  FreeModelCatalog,
  HouseAiService,
  HouseQuota,
  OpenRouterConnect,
} from './modules/house-ai/index.js';
import type { OpenRouterAccountPort } from './ports/openrouter-account.js';
import type { SecretSealerPort } from './ports/secret-sealer.js';
import type { SpendLedgerPort } from './ports/spend-ledger.js';

/** The house plan's pieces (KBC-022, ADR 0016), built once by the composition root. */
export interface HouseAi {
  readonly service: HouseAiService;
  readonly catalog: FreeModelCatalog;
  readonly quota: HouseQuota;
  /** The paid fallback's spend, apart from people's own keys. */
  readonly spend: SpendLedgerPort;
  readonly connect: OpenRouterConnect;
  readonly account: OpenRouterAccountPort;
  /** The HTTP the house's chat requests use (the same fake as the account's in tests). */
  readonly fetch?: typeof fetch;
}

export interface HouseAiOptions {
  /** The state folder; in memory without one (tests). */
  readonly stateDir?: string;
  readonly sealer: SecretSealerPort;
  readonly webOrigin: string;
  /** HTTP to OpenRouter (a fake in tests and E2E). */
  readonly fetch?: typeof fetch;
  /** The consent page (the E2E server's fake); OpenRouter's by default. */
  readonly authorizeUrl?: string;
  readonly warn?: (message: string) => void;
}

/** house-ai.json, house-usage.jsonl and house-spend.jsonl, or the same in memory. */
function stores(stateDir: string | undefined) {
  if (!stateDir)
    return {
      config: new MemoryDocumentStore(),
      usage: new MemoryHouseUsage(),
      spend: new MemorySpendLedger(),
    };
  return {
    config: new JsonDocumentStore(join(stateDir, 'house-ai.json')),
    usage: new JsonlHouseUsage(join(stateDir, 'house-usage.jsonl')),
    spend: new JsonlSpendLedger(join(stateDir, 'house-spend.jsonl')),
  };
}

export async function createHouseAi(options: HouseAiOptions): Promise<HouseAi> {
  const { sealer, warn } = options;
  const store = stores(options.stateDir);
  const account = new OpenRouterAccountClient({ fetch: options.fetch });
  const catalog = new FreeModelCatalog({ account, warn });
  const service = new HouseAiService({
    store: store.config,
    sealer,
    account,
    catalog,
    warn,
  });
  await service.load();
  // The free-model list in memory early, so the first answer has the real chain.
  void service.ready();
  return {
    service,
    catalog,
    quota: new HouseQuota({ ledger: store.usage }),
    spend: store.spend,
    connect: new OpenRouterConnect({
      webOrigin: options.webOrigin,
      authorizeUrl: options.authorizeUrl,
    }),
    account,
    fetch: options.fetch,
  };
}
