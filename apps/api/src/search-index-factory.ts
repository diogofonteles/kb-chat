import { FixtureSearchAdapter } from './adapters/fixture-search-adapter.js';
import { KbCliSearchAdapter } from './adapters/kb-cli-search-adapter.js';
import { QmdMcpAdapter } from './adapters/qmd-mcp-adapter.js';
import { ResilientSearchIndex } from './adapters/resilient-search-index.js';
import type { AppConfig } from './config.js';
import type { SearchIndexPort } from './ports/search-index.js';
import type { VaultReaderPort } from './ports/vault-reader.js';

export interface SearchIndexFactoryOptions {
  readonly config: AppConfig;
  readonly vault: VaultReaderPort;
  readonly log: (message: string) => void;
}

/** Composition of the search index from config; MCP failure falls back to the kb CLI. */
export async function createSearchIndex(
  options: SearchIndexFactoryOptions,
): Promise<SearchIndexPort> {
  const { config, vault, log } = options;
  if (config.KB_CHAT_SEARCH === 'fixture') {
    const topics = await vault.listTopics();
    const byCollection = new Map(
      topics.map((topic) => [topic.slug.replace(/\//g, '-'), topic.slug]),
    );
    return new FixtureSearchAdapter(
      vault,
      (collection) => byCollection.get(collection) ?? collection,
    );
  }
  const mcp = new QmdMcpAdapter({ command: config.QMD_BIN, onLog: log });
  try {
    await mcp.start();
  } catch (err) {
    log(
      `qmd mcp failed to start, using kb search: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return new ResilientSearchIndex(
    mcp,
    new KbCliSearchAdapter({ command: config.KB_BIN, vault: config.KB_VAULT }),
  );
}
