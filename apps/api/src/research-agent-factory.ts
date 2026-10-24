import type { SubscriptionPrompt } from './adapters/subscription-prompt.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import {
  ResearchTools,
  ToolLoopRunner,
  researchSystemPrompt,
  turnToolsFactory,
} from './modules/research/index.js';
import { SearchService } from './modules/search/index.js';
import { SpendService } from './modules/spend/index.js';
import type { PerTokenRunnerFactory } from './ports/research-runner.js';
import type { ResearchToolsFactory } from './ports/research-tools.js';
import type { SearchIndexPort } from './ports/search-index.js';
import type { SpendLedgerPort } from './ports/spend-ledger.js';
import type { VaultReaderPort } from './ports/vault-reader.js';

export interface ResearchAgentDeps {
  readonly catalog: CatalogRegistry;
  readonly index: SearchIndexPort;
  readonly vault: VaultReaderPort;
  readonly ledger: SpendLedgerPort;
}

/**
 * The research agent's pieces (ADR 0006) for every runner (ADR 0007): one set of tools
 * (and one find_text cache) behind the in-API loop and the subscription CLIs' MCP turns,
 * and one prompt for both.
 */
export interface ResearchAgent {
  readonly search: SearchService;
  readonly tools: ResearchTools;
  /** A fresh tool set per subscription turn, with its own [n] numbering. */
  readonly toolsFor: ResearchToolsFactory;
  /** The in-API loop over a per-token model, spending on the given principal's ledger. */
  readonly perTokenRunner: PerTokenRunnerFactory;
  /** The research rules with the topic's title and the profile, for the subscription CLIs. */
  readonly systemPrompt: SubscriptionPrompt;
}

export function createResearchAgent(deps: ResearchAgentDeps): ResearchAgent {
  const { catalog, index, vault, ledger } = deps;
  const search = new SearchService({ catalog, index, vault });
  const tools = new ResearchTools({ search, catalog, vault });
  return {
    search,
    tools,
    toolsFor: turnToolsFactory(tools),
    perTokenRunner: (llm, scope) =>
      new ToolLoopRunner({
        llm,
        tools,
        spend: new SpendService({ llm, ledger, ...scope }),
      }),
    systemPrompt: (topic, profile) =>
      researchSystemPrompt(tools.topicTitle(topic) ?? topic, profile),
  };
}
