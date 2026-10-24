import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import type {
  IndexHit,
  IndexQuery,
  SearchIndexPort,
  SearchIndexStatus,
} from '../ports/search-index.js';
import { toTopicRelativeId, toTypedSearches } from './search-mode-queries.js';

const resultSchema = z.object({
  structuredContent: z.object({
    results: z.array(
      z.object({
        file: z.string(),
        score: z.number(),
        snippet: z.string().default(''),
      }),
    ),
  }),
});

export interface QmdMcpOptions {
  readonly command: string;
  readonly args?: readonly string[];
  /** Delays between restart attempts after the process dies or fails to start, in ms. */
  readonly backoffMs?: readonly number[];
  /** Collection queried once per mode right after connecting, so the first search is warm. */
  readonly warmCollection?: string;
  readonly onLog?: (message: string) => void;
}

const DEFAULT_BACKOFF_MS = [500, 2_000, 10_000, 30_000] as const;
const WARM_QUERY = 'warm up';

/** Keeps one `qmd mcp` child alive so the embedding model stays loaded (ADR 0002). */
export class QmdMcpAdapter implements SearchIndexPort {
  private client: Client | null = null;
  private failures = 0;
  private closed = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: QmdMcpOptions) {}

  /** Connects once; a failure is reported to the caller and retried in the background. */
  async start(): Promise<void> {
    try {
      await this.connect();
    } catch (err) {
      this.scheduleRestart();
      throw err;
    }
  }

  status(): SearchIndexStatus {
    return this.client ? 'ok' : 'down';
  }

  async search(query: IndexQuery): Promise<readonly IndexHit[]> {
    const client = this.client;
    if (!client) throw new Error('qmd mcp is not connected');
    const raw = await client.callTool({
      name: 'query',
      arguments: {
        searches: toTypedSearches(query.mode, query.q),
        collections: [query.collection],
        limit: query.limit,
        rerank: false,
      },
    });
    const parsed = resultSchema.parse(raw);
    return parsed.structuredContent.results.map((hit) => ({
      id: toTopicRelativeId(hit.file, query.collection),
      score: hit.score,
      snippet: hit.snippet,
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const client = this.client;
    this.client = null;
    await client?.close();
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: [...(this.options.args ?? ['mcp'])],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'kb-chat', version: '0.0.0' });
    await client.connect(transport);
    // Registered after a successful connect (a failed start is retried by start() only);
    // Client.onclose keeps the SDK's own transport handler that rejects pending calls.
    client.onclose = () => this.handleClose(client);
    this.client = client;
    this.failures = 0;
    void this.warmUp();
  }

  private async warmUp(): Promise<void> {
    const collection = this.options.warmCollection;
    if (!collection) return;
    for (const mode of ['exact', 'semantic'] as const) {
      await this.search({ collection, q: WARM_QUERY, mode, limit: 1 }).catch(
        (err: unknown) => {
          this.options.onLog?.(
            `qmd warm-up (${mode}) failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        },
      );
    }
  }

  private handleClose(client: Client): void {
    if (this.client !== client) return;
    this.client = null;
    this.scheduleRestart();
  }

  /** The single place that schedules a retry; at most one timer exists at a time. */
  private scheduleRestart(): void {
    if (this.closed || this.restartTimer) return;
    const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF_MS;
    const delay =
      backoff[Math.min(this.failures, backoff.length - 1)] ?? 30_000;
    this.failures += 1;
    this.options.onLog?.(`qmd mcp unavailable; retrying in ${delay} ms`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.connect().catch(() => this.scheduleRestart());
    }, delay);
    this.restartTimer.unref();
  }
}
