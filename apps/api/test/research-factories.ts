import { FsVaultAdapter } from '../src/adapters/fs-vault-adapter.js';
import { MemorySpendLedger } from '../src/adapters/memory-spend-ledger.js';
import {
  StubLlmAdapter,
  type StubLlmOptions,
} from '../src/adapters/stub-llm-adapter.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { CatalogRegistry } from '../src/modules/catalog/index.js';
import {
  ResearchTools,
  SourceBook,
  ToolLoopRunner,
  type ToolContext,
} from '../src/modules/research/index.js';
import { SearchService } from '../src/modules/search/index.js';
import { SpendService } from '../src/modules/spend/index.js';
import type { ResearchEvent } from '@kb-chat/contracts';
import { createSearchIndex } from '../src/search-index-factory.js';
import { FIXTURE_VAULT } from './fixture-paths.js';

/** The research tools over the fixture vault and the in-process index. */
export async function fixtureTools(): Promise<ResearchTools> {
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
  });
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const index = await createSearchIndex({
    config,
    vault,
    log: createLogger('silent'),
  });
  const catalog = new CatalogRegistry(vault);
  await catalog.load();
  const search = new SearchService({ catalog, index, vault });
  return new ResearchTools({ search, catalog, vault });
}

export const hermetismoContext = (): ToolContext => ({
  topic: 'hermetismo',
  book: new SourceBook(),
});

export interface RunnerFixture {
  readonly runner: ToolLoopRunner;
  readonly llm: StubLlmAdapter;
  readonly ledger: MemorySpendLedger;
}

/** A tool-loop runner over the stub model and a memory ledger. */
export async function fixtureRunner(
  llmOptions: StubLlmOptions = {},
  dailyCapUsd = 1,
): Promise<RunnerFixture> {
  const llm = new StubLlmAdapter(llmOptions);
  const ledger = new MemorySpendLedger();
  const spend = new SpendService({
    llm,
    ledger,
    dailyCapUsd: () => dailyCapUsd,
    principal: 'owner',
  });
  const runner = new ToolLoopRunner({
    llm,
    tools: await fixtureTools(),
    spend,
  });
  return { runner, llm, ledger };
}

/** Every event of one research turn. */
export async function collectEvents(
  events: AsyncIterable<ResearchEvent>,
): Promise<ResearchEvent[]> {
  const all: ResearchEvent[] = [];
  for await (const event of events) all.push(event);
  return all;
}

/** The answer as the reader ends up seeing it: tokens by segment, minus the retracted ones. */
export function answerText(events: readonly ResearchEvent[]): string {
  const segments = new Map<number, string>();
  for (const event of events) {
    if (event.type === 'token')
      segments.set(
        event.segment,
        (segments.get(event.segment) ?? '') + event.text,
      );
    if (event.type === 'retract') segments.delete(event.segment);
  }
  return [...segments.values()].join('');
}
