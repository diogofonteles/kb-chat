import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { modelIdSchema } from '@kb-chat/contracts';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
import { z } from 'zod';
import { spawnCli, type CliProcess } from '../adapters/cli-process.js';
import { codexArgs } from '../adapters/codex-cli-runner.js';
import { CODEX_TOKEN_ENV, RUNNER_EXIT } from '../adapters/remote-cli.js';

/** How long `codex login status` may take before it counts as logged out. */
const STATUS_TIMEOUT_MS = 10_000;
const LOOPBACK = new Set(['127.0.0.1', '::1']);

export interface CodexRunnerOptions {
  /** The Codex binary (a probe in the sandbox proof, a fake in tests). */
  readonly bin: string;
  /** The only folder of Codex's own: its login and caches (a volume in production). */
  readonly codexHome: string;
  /** The API's MCP endpoint for turns (bearer); the runner never takes another one. */
  readonly mcpUrl: string;
  readonly host: string;
  readonly port: number;
  /** The runner's own variables Codex may keep: PATH and the locale, nothing else. */
  readonly env: { readonly PATH: string; readonly LANG?: string };
  /** Who may send turns, by socket address (the API); empty: loopback only. */
  readonly allowedClients?: readonly string[];
  /** Where each turn's empty working folder is made; default the system temp folder. */
  readonly tmpRoot?: string;
  /**
   * Kill what a former turn left in the container before each turn (the container only:
   * `codex-runner-main`); never in tests or the E2E server, which share the host.
   */
  readonly reapStrays?: boolean;
}

export interface CodexRunner {
  readonly url: string;
  /** Codex processes running now. */
  active(): number;
  /** Turns started and `codex login status` checks so far (observability, tests). */
  counts(): { turns: number; statusChecks: number };
  close(): Promise<void>;
}

/**
 * POST /turn: what the API sends. The runner builds the locked-down arguments itself, with
 * its own MCP address, so no caller can start a Codex with other switches (ADR 0020).
 */
const turnSchema = z.strictObject({
  model: modelIdSchema.optional(),
  input: z.string().max(1_000_000),
  token: z.string().min(16).max(64),
});
type Turn = z.infer<typeof turnSchema>;

/** The whole environment of a Codex process (ADR 0020 BR-2): no variable of the runner leaks. */
function codexEnv(
  options: CodexRunnerOptions,
  token?: string,
): NodeJS.ProcessEnv {
  return {
    PATH: options.env.PATH,
    ...(options.env.LANG && { LANG: options.env.LANG }),
    HOME: options.codexHome,
    CODEX_HOME: options.codexHome,
    ...(token && { [CODEX_TOKEN_ENV]: token }),
  };
}

const exitLine = (code: number | null) =>
  `${JSON.stringify({ type: RUNNER_EXIT, code })}\n`;

/** One turn at a time: no Codex process can read a sibling turn's token in /proc. */
class TurnLock {
  private tail: Promise<void> = Promise.resolve();

  acquire(): Promise<() => void> {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = this.tail;
    this.tail = before.then(() => held);
    return before.then(() => release);
  }
}

/** Copies the CLI's lines to the response, then its exit code; the folder goes at the end. */
async function relay(
  cli: CliProcess,
  out: PassThrough,
  dir: string,
): Promise<void> {
  try {
    for await (const line of cli.lines) out.write(`${line}\n`);
    out.end(exitLine(await cli.exit));
  } catch {
    out.end(exitLine(-1));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** The socket address, IPv4 unmapped; never a header. */
const addressOf = (request: FastifyRequest): string =>
  (request.socket.remoteAddress ?? '').replace(/^::ffff:/, '');

function allowedCaller(options: CodexRunnerOptions) {
  const clients = new Set(options.allowedClients ?? []);
  return (request: FastifyRequest): boolean => {
    const address = addressOf(request);
    return clients.size > 0 ? clients.has(address) : LOOPBACK.has(address);
  };
}

interface TurnContext {
  readonly options: CodexRunnerOptions;
  readonly running: Set<CliProcess>;
  readonly lock: TurnLock;
  readonly counts: { turns: number; statusChecks: number };
}

/** Counts the process, frees the lock when it exits, and stops it if the API leaves. */
function track(
  { running }: TurnContext,
  turn: { cli: CliProcess; release: () => void; reply: FastifyReply },
): void {
  const { cli, release, reply } = turn;
  running.add(cli);
  void cli.exit.then(() => {
    running.delete(cli);
    release();
  });
  // The API gave up on the turn (stop, timeout), even during the start: the group goes too.
  if (reply.raw.destroyed) cli.kill();
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) cli.kill();
  });
}

/** Codex in a fresh empty folder, with the arguments the runner builds itself. */
async function spawnTurn(
  options: CodexRunnerOptions,
  turn: Turn,
): Promise<{ dir: string; cli: CliProcess }> {
  const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'turn-'));
  try {
    const cli = spawnCli({
      bin: options.bin,
      args: codexArgs(options.mcpUrl, turn.model),
      cwd: dir,
      env: codexEnv(options, turn.token),
      input: turn.input,
    });
    return { dir, cli };
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
}

/** pid → parent pid of every process this user can see (Linux /proc). */
async function processTree(): Promise<Map<number, number>> {
  const tree = new Map<number, number>();
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await readFile(`/proc/${name}/stat`, 'utf8').catch(() => '');
    // Field 4, after the command in parentheses, is the parent pid.
    const parent = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    if (Number.isInteger(parent)) tree.set(Number(name), parent);
  }
  return tree;
}

/** Whether the pid comes from a former turn: its ancestry reaches init without the runner. */
function isStray(tree: Map<number, number>, pid: number): boolean {
  let current = pid;
  for (let hops = 0; hops < 64; hops += 1) {
    if (current === process.pid) return false;
    const parent = tree.get(current);
    // `docker exec` and the healthcheck come from outside (parent 0): not a turn's.
    if (parent === undefined || parent === 0) return false;
    if (parent === 1) return current !== process.pid;
    current = parent;
  }
  return false;
}

/**
 * Kills every process a former turn left behind, with its whole family (ADR 0020): the lock
 * is held, so no turn runs now, and anything descending from init but not from the runner
 * would otherwise outlive its turn and read the next one's token. Repeats while it kills.
 */
async function reapStrays(): Promise<void> {
  for (let pass = 0; pass < 3; pass += 1) {
    const tree = await processTree();
    const strays = [...tree.keys()].filter(
      (pid) => pid !== 1 && pid !== process.pid && isStray(tree, pid),
    );
    if (strays.length === 0) return;
    strays.forEach(killQuietly);
  }
}

function killQuietly(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

async function startTurn(
  context: TurnContext,
  turn: Turn,
  reply: FastifyReply,
): Promise<PassThrough | null> {
  const { options } = context;
  const release = await context.lock.acquire();
  // The API gave up while this turn waited: nothing to start.
  if (reply.raw.destroyed) {
    release();
    return null;
  }
  let started: { dir: string; cli: CliProcess };
  try {
    if (options.reapStrays) await reapStrays();
    started = await spawnTurn(options, turn);
    context.counts.turns += 1;
  } catch (err) {
    // Never keep the lock of a turn that did not start: every later turn would wait on it.
    release();
    throw err;
  }
  const { dir, cli } = started;
  track(context, { cli, release, reply });
  const out = new PassThrough();
  void relay(cli, out, dir);
  return out;
}

function registerTurn(app: FastifyInstance, context: TurnContext) {
  const allowed = allowedCaller(context.options);
  app.post('/turn', async (request, reply) => {
    if (!allowed(request)) return reply.code(403).send({ error: 'FORBIDDEN' });
    const parsed = turnSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const out = await startTurn(context, parsed.data, reply);
    if (!out) return reply;
    return reply.type('application/x-ndjson').send(out);
  });
  app.get('/status', async (request, reply) => {
    if (!allowed(request)) return reply.code(403).send({ error: 'FORBIDDEN' });
    context.counts.statusChecks += 1;
    return { loggedIn: await loggedIn(context.options) };
  });
}

/** `codex login status`: exit 0 means the owner's login is there. */
async function loggedIn(options: CodexRunnerOptions): Promise<boolean> {
  const cli = spawnCli({
    bin: options.bin,
    args: ['login', 'status'],
    cwd: options.codexHome,
    env: codexEnv(options),
    input: '',
  });
  const timer = setTimeout(() => cli.kill(), STATUS_TIMEOUT_MS);
  try {
    for await (const line of cli.lines) void line;
    return (await cli.exit) === 0;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Codex sandbox runner (KBC-027, ADR 0020): in the Codex container, it runs one Codex
 * process at a time for the API, with locked-down arguments it builds itself, an empty folder
 * and only its own environment, and streams the process's lines back.
 */
export async function startCodexRunner(
  options: CodexRunnerOptions,
): Promise<CodexRunner> {
  // On shutdown every turn ends at once: its connections too, not only the idle ones.
  const app = Fastify({
    bodyLimit: 2 * 1024 * 1024,
    forceCloseConnections: true,
  });
  const running = new Set<CliProcess>();
  const counts = { turns: 0, statusChecks: 0 };
  registerTurn(app, { options, running, lock: new TurnLock(), counts });
  app.get('/health', async () => ({ status: 'ok' }));
  app.addHook('onClose', async () => {
    for (const cli of running) cli.kill();
  });
  await app.listen({ host: options.host, port: options.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://${options.host}:${port}`,
    active: () => running.size,
    counts: () => ({ ...counts }),
    close: () => app.close(),
  };
}
