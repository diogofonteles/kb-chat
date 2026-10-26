import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { spawnCli, type CliProcess } from '../adapters/cli-process.js';
import { CODEX_TOKEN_ENV, RUNNER_EXIT } from '../adapters/remote-cli.js';

/** How long `codex login status` may take before it counts as logged out. */
const STATUS_TIMEOUT_MS = 10_000;

export interface CodexRunnerOptions {
  /** The Codex binary (a probe in the sandbox proof, a fake in tests). */
  readonly bin: string;
  /** The only folder of Codex's own: its login and caches (a volume in production). */
  readonly codexHome: string;
  readonly host: string;
  readonly port: number;
  /** The runner's own variables Codex may keep: PATH and the locale, nothing else. */
  readonly env: { readonly PATH: string; readonly LANG?: string };
  /** Where each turn's empty working folder is made; default the system temp folder. */
  readonly tmpRoot?: string;
}

export interface CodexRunner {
  readonly url: string;
  /** Codex processes running now. */
  active(): number;
  close(): Promise<void>;
}

/** POST /turn: what the API sends; the runner adds nothing but CODEX_HOME and the locale. */
const turnSchema = z.strictObject({
  args: z.array(z.string().max(4000)).min(1).max(80),
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

function registerTurn(
  app: FastifyInstance,
  options: CodexRunnerOptions,
  running: Set<CliProcess>,
) {
  app.post('/turn', async (request, reply) => {
    const parsed = turnSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'VALIDATION_FAILED' });
    const turn: Turn = parsed.data;
    const dir = await mkdtemp(join(options.tmpRoot ?? tmpdir(), 'turn-'));
    const cli = spawnCli({
      bin: options.bin,
      args: turn.args,
      cwd: dir,
      env: codexEnv(options, turn.token),
      input: turn.input,
    });
    running.add(cli);
    void cli.exit.then(() => running.delete(cli));
    // The API gave up on the turn (stop, timeout): the process group goes too.
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) cli.kill();
    });
    const out = new PassThrough();
    void relay(cli, out, dir);
    return reply.type('application/x-ndjson').send(out);
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
 * process per turn the API sends, with an argument array (no shell), an empty folder and only
 * its own environment, and streams the process's lines back.
 */
export async function startCodexRunner(
  options: CodexRunnerOptions,
): Promise<CodexRunner> {
  const app = Fastify({ bodyLimit: 2 * 1024 * 1024 });
  const running = new Set<CliProcess>();
  registerTurn(app, options, running);
  app.get('/status', async () => ({ loggedIn: await loggedIn(options) }));
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
    close: () => app.close(),
  };
}
