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

/** What the adapter uses of an MCP client: one per `qmd mcp` child process. */
export interface QmdClient {
  callTool(params: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
  close(): Promise<void>;
  /** Called when the child exits or the transport closes. */
  onclose?: (() => void) | undefined;
}

export interface QmdMcpOptions {
  readonly command: string;
  readonly args?: readonly string[];
  /** Delays between restart attempts after the process dies or fails to start, in ms. */
  readonly backoffMs?: readonly number[];
  /** Collection queried once per mode right after connecting, so the first search is warm. */
  readonly warmCollection?: string;
  readonly onLog?: (message: string) => void;
  /** How long a swapped-out process may finish its searches before it is closed, in ms. */
  readonly drainMs?: number;
  /** Starts a `qmd mcp` and connects to it (tests count processes with a fake one). */
  readonly openClient?: () => Promise<QmdClient>;
}

/** A research turn's search is seconds long; a turn's tool loop, minutes at most. */
const DEFAULT_DRAIN_MS = 5 * 60 * 1000;
const DRAIN_POLL_MS = 50;

const DEFAULT_BACKOFF_MS = [500, 2_000, 10_000, 30_000] as const;
const WARM_QUERY = 'warm up';

/** Keeps one `qmd mcp` child alive so the embedding model stays loaded (ADR 0002). */
export class QmdMcpAdapter implements SearchIndexPort {
  private client: QmdClient | null = null;
  /** Searches running on each process, so a swapped-out one is closed only when idle. */
  private readonly inFlight = new Map<QmdClient, number>();
  /** Swapped-out processes finishing their searches (closed with the adapter). */
  private readonly retiring = new Set<Promise<void>>();
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
    this.inFlight.set(client, (this.inFlight.get(client) ?? 0) + 1);
    let raw: unknown;
    try {
      raw = await client.callTool({
        name: 'query',
        arguments: {
          searches: toTypedSearches(query.mode, query.q),
          collections: [query.collection],
          limit: query.limit,
          rerank: false,
        },
      });
    } finally {
      this.inFlight.set(client, (this.inFlight.get(client) ?? 1) - 1);
    }
    const parsed = resultSchema.parse(raw);
    return parsed.structuredContent.results.map((hit) => ({
      id: toTopicRelativeId(hit.file, query.collection),
      score: hit.score,
      snippet: hit.snippet,
    }));
  }

  async close(): Promise<void> {
    this.closed = true;
    this.cancelRestart();
    const client = this.client;
    this.client = null;
    await client?.close();
    await Promise.all(this.retiring);
  }

  private async connect(): Promise<void> {
    if (this.closed) return;
    const client = await this.open();
    if (this.closed) {
      // close() ran while this reconnect was in flight: do not leave the child alive.
      await client.close();
      return;
    }
    this.use(client);
  }

  private async open(): Promise<QmdClient> {
    if (this.options.openClient) return this.options.openClient();
    const transport = new StdioClientTransport({
      command: this.options.command,
      args: [...(this.options.args ?? ['mcp'])],
      stderr: 'ignore',
    });
    const client = new Client({ name: 'kb-chat', version: '0.0.0' });
    await client.connect(transport);
    return client;
  }

  /**
   * The process that takes the next searches. Whichever connected before it (a reload and a
   * reconnect that crossed) finishes its searches and closes: never two left alive (review 2).
   */
  private use(client: QmdClient): void {
    // Registered after a successful connect (a failed start is retried by start() only);
    // Client.onclose keeps the SDK's own transport handler that rejects pending calls.
    client.onclose = () => this.handleClose(client);
    const previous = this.client;
    this.client = client;
    this.failures = 0;
    if (previous && previous !== client) this.drainApart(previous);
    void this.warmUp();
  }

  /**
   * A new index is in place (KBC-100 FR-5): a new `qmd mcp` opens it and takes the next
   * searches; the old one finishes what it was doing, then closes. Search is never down: if
   * the new process does not start, the old one keeps serving and the error is thrown.
   * A reconnect waiting for its turn is dropped: the new process is the reconnect. If it
   * fails and no process serves, the reconnect is scheduled again (review 3): search must
   * not stay on the `kb search` fallback until the next trigger.
   */
  async reload(): Promise<void> {
    if (this.closed) return;
    this.cancelRestart();
    let next: QmdClient;
    try {
      next = await this.open();
    } catch (err) {
      if (!this.client) this.scheduleRestart();
      throw err;
    }
    if (this.closed) {
      await next.close();
      return;
    }
    // A reconnect scheduled while this one was opening would start a third process.
    this.cancelRestart();
    this.use(next);
  }

  private cancelRestart(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }

  /** Drained apart: the swap is done as soon as the new process answers. */
  private drainApart(previous: QmdClient): void {
    const retired = this.retire(previous).finally(() =>
      this.retiring.delete(retired),
    );
    this.retiring.add(retired);
  }

  private async retire(client: QmdClient): Promise<void> {
    const until = Date.now() + (this.options.drainMs ?? DEFAULT_DRAIN_MS);
    while (
      !this.closed &&
      (this.inFlight.get(client) ?? 0) > 0 &&
      Date.now() < until
    )
      await new Promise((done) => setTimeout(done, DRAIN_POLL_MS));
    this.inFlight.delete(client);
    await client.close().catch((err: unknown) => {
      this.options.onLog?.(
        `qmd mcp (swapped out) did not close: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
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

  private handleClose(client: QmdClient): void {
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
      this.connect().catch((err: unknown) => {
        if (this.closed) return;
        this.options.onLog?.(
          `qmd mcp reconnect failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        this.scheduleRestart();
      });
    }, delay);
    this.restartTimer.unref();
  }
}
