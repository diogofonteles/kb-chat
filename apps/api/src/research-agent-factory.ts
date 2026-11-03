import type { SubscriptionPrompt } from './adapters/subscription-prompt.js';
import type { CatalogRegistry } from './modules/catalog/index.js';
import type { AppConfig } from './config.js';
import {
  ResearchTools,
  ToolLoopRunner,
  researchBudgets,
  researchSystemPrompt,
  turnToolsFactory,
  type ResearchBudgets,
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
  /** Per-profile budgets (ADR 0013); default: the module's, without server settings. */
  readonly budgets?: ResearchBudgets;
  /** The collection's main author's name (KBC-049): the authorship rule names him. */
  readonly mainAuthorOf?: (topic: string) => string | null;
}

/** The research budgets with the server's exhaustive-profile settings (KBC-017). */
export const budgetsFromConfig = (
  config: Pick<
    AppConfig,
    | 'KB_CHAT_EXHAUSTIVE_STEPS'
    | 'KB_CHAT_EXHAUSTIVE_OUTPUT_TOKENS'
    | 'KB_CHAT_SWEEP_MAX_REQUESTS'
  >,
): ResearchBudgets =>
  researchBudgets({
    steps: config.KB_CHAT_EXHAUSTIVE_STEPS,
    outputTokens: config.KB_CHAT_EXHAUSTIVE_OUTPUT_TOKENS,
    sweepRequests: config.KB_CHAT_SWEEP_MAX_REQUESTS,
  });

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

/** The in-API loop over a per-token model, spending on the principal's ledger. */
const perTokenRunnerOf =
  ({
    tools,
    ledger,
    budgets,
  }: {
    tools: ResearchTools;
    ledger: SpendLedgerPort;
    budgets?: ResearchBudgets;
  }): PerTokenRunnerFactory =>
  (llm, { ledger: own, ...scope }, escalation) =>
    new ToolLoopRunner({
      llm,
      tools,
      budgets,
      spend: new SpendService({ llm, ledger: own ?? ledger, ...scope }),
      ...(escalation && {
        deep: {
          llm: escalation.deep,
          spend: new SpendService({
            llm: escalation.deep,
            ledger: own ?? ledger,
            ...scope,
          }),
        },
        autoDeepen: escalation.enabled,
      }),
    });

export function createResearchAgent(deps: ResearchAgentDeps): ResearchAgent {
  const { catalog, index, vault, ledger, budgets, mainAuthorOf } = deps;
  const search = new SearchService({ catalog, index, vault });
  const tools = new ResearchTools({
    search,
    catalog,
    vault,
    ...(mainAuthorOf && { mainAuthorOf }),
  });
  return {
    search,
    tools,
    toolsFor: turnToolsFactory(tools),
    perTokenRunner: perTokenRunnerOf({ tools, ledger, budgets }),
    systemPrompt: (topic, profile, canDeepen) =>
      researchSystemPrompt(
        {
          title: tools.topicTitle(topic) ?? topic,
          mainAuthor: tools.mainAuthor(topic),
        },
        profile,
        canDeepen,
      ),
  };
}
