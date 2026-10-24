import { FixtureSearchAdapter } from './adapters/fixture-search-adapter.js';
import { KbCliSearchAdapter } from './adapters/kb-cli-search-adapter.js';
import { QmdMcpAdapter } from './adapters/qmd-mcp-adapter.js';
import { ResilientSearchIndex } from './adapters/resilient-search-index.js';
import type { AppConfig } from './config.js';
import { toCollection } from './modules/search/index.js';
import type { SearchIndexPort } from './ports/search-index.js';
import type { VaultReaderPort } from './ports/vault-reader.js';

/** The slice of the pino logger the index composition needs. */
export interface IndexLog {
  warn(obj: object, msg?: string): void;
}

export interface SearchIndexFactoryOptions {
  readonly config: AppConfig;
  readonly vault: VaultReaderPort;
  readonly log: IndexLog;
}

async function createFixtureIndex(
  vault: VaultReaderPort,
): Promise<SearchIndexPort> {
  const topics = await vault.listTopics();
  const byCollection = new Map(
    topics.map((topic) => [toCollection(topic.slug), topic.slug]),
  );
  return new FixtureSearchAdapter(
    vault,
    (collection) => byCollection.get(collection) ?? collection,
  );
}

/** Same default as the web: the topic with the most documents is the one opened first. */
async function largestTopic(
  vault: VaultReaderPort,
): Promise<string | undefined> {
  const topics = await vault.listTopics();
  const sized = await Promise.all(
    topics.map(async (topic) => ({
      slug: topic.slug,
      size: (await vault.listDocuments(topic.slug)).length,
    })),
  );
  return sized.sort((a, b) => b.size - a.size)[0]?.slug;
}

/** Composition of the search index from config; MCP failure falls back to the kb CLI. */
export async function createSearchIndex(
  options: SearchIndexFactoryOptions,
): Promise<SearchIndexPort> {
  const { config, vault, log } = options;
  if (config.KB_CHAT_SEARCH === 'fixture') return createFixtureIndex(vault);
  const warmTopic = config.KB_TOPIC ?? (await largestTopic(vault));
  const mcp = new QmdMcpAdapter({
    command: config.QMD_BIN,
    warmCollection: warmTopic ? toCollection(warmTopic) : undefined,
    onLog: (message) => log.warn({ component: 'qmd' }, message),
  });
  try {
    await mcp.start();
  } catch (err) {
    log.warn({ err }, 'qmd mcp failed to start, using kb search');
  }
  const cli = new KbCliSearchAdapter({
    command: config.KB_BIN,
    vault: config.KB_VAULT,
  });
  return new ResilientSearchIndex(mcp, cli, (err) =>
    log.warn({ err }, 'qmd search failed, using kb search'),
  );
}
