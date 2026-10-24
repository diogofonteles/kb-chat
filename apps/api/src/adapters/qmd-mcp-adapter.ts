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
  /** Delays between restart attempts after the process dies, in ms. */
  readonly backoffMs?: readonly number[];
  readonly onLog?: (message: string) => void;
}

const DEFAULT_BACKOFF_MS = [500, 2_000, 10_000, 30_000] as const;

/** Keeps one `qmd mcp` child alive so the embedding model stays loaded (ADR 0002). */
export class QmdMcpAdapter implements SearchIndexPort {
  private client: Client | null = null;
  private connecting: Promise<void> | null = null;
  private failures = 0;
  private closed = false;
  private restartTimer: NodeJS.Timeout | null = null;

  constructor(private readonly options: QmdMcpOptions) {}

  async start(): Promise<void> {
    this.connecting ??= this.connect().finally(() => {
      this.connecting = null;
    });
    await this.connecting;
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
    const client = this.client;
    this.client = null;
    await client?.close();
  }

  private async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: [...(this.options.args ?? ['mcp'])],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'kb-chat', version: '0.0.0' });
    transport.onclose = () => this.handleClose(client);
    await client.connect(transport);
    this.client = client;
    this.failures = 0;
  }

  private handleClose(client: Client): void {
    if (this.client === client) this.client = null;
    if (this.closed) return;
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    const backoff = this.options.backoffMs ?? DEFAULT_BACKOFF_MS;
    const delay =
      backoff[Math.min(this.failures, backoff.length - 1)] ?? 30_000;
    this.failures += 1;
    this.options.onLog?.(`qmd mcp exited; restarting in ${delay} ms`);
    this.restartTimer = setTimeout(() => {
      this.start().catch((err: unknown) => {
        this.options.onLog?.(
          `qmd mcp restart failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref();
  }
}
