import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** How often the trigger file is looked at: a swap is seen within this. */
export const INDEX_TRIGGER_POLL_MS = 5_000;

/** Where install-index.sh --hot writes, in QMD's cache folder (mounted read-write). */
export const defaultIndexTrigger = (): string =>
  join(homedir(), '.cache', 'qmd', 'reload-index');

/** What the trigger asks for: the index search reopens, then the catalog reads the vault. */
export interface IndexReloadDeps {
  /** The file install-index.sh --hot writes (its content names the new index). */
  readonly trigger: string;
  readonly reloadIndex: () => Promise<void>;
  readonly reloadCatalog: () => Promise<void>;
  readonly log: {
    info(obj: object, msg?: string): void;
    error(obj: object, msg?: string): void;
  };
  readonly pollMs?: number;
}

const changedAt = async (path: string): Promise<number | null> =>
  stat(path).then(
    (found) => found.mtimeMs,
    () => null,
  );

/**
 * The hot swap of the QMD index (KBC-100 FR-5, ADR 0035 §9): install-index.sh --hot puts
 * the new index in place and writes the trigger; this restarts only the `qmd mcp` child
 * (searches in flight finish on the old one), reads the catalog again, so production sees
 * the new documents, and answers with `<trigger>.ack` holding what it read. The API never
 * stops. A trigger already there at start is the index the API opened: it is not reloaded.
 */
export class IndexReloadWatcher {
  private seen: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> = Promise.resolve();

  constructor(private readonly deps: IndexReloadDeps) {}

  async start(): Promise<void> {
    this.seen = await changedAt(this.deps.trigger);
    this.timer = setInterval(() => {
      this.running = this.running.then(() => this.check());
    }, this.deps.pollMs ?? INDEX_TRIGGER_POLL_MS);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }

  /** One look at the trigger; a swap when it changed since the last one. */
  async check(): Promise<void> {
    const now = await changedAt(this.deps.trigger);
    if (now === null || now === this.seen) return;
    this.seen = now;
    const asked = (await readFile(this.deps.trigger, 'utf8')).trim();
    try {
      await this.deps.reloadIndex();
      await this.deps.reloadCatalog();
      await writeFile(`${this.deps.trigger}.ack`, `${asked}\n`, 'utf8');
      this.deps.log.info({ index: asked }, 'search index reloaded');
    } catch (err) {
      // No ack: install-index.sh puts the previous index back after its wait.
      this.deps.log.error({ err, index: asked }, 'search index reload failed');
    }
  }
}
