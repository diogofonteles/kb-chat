import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

/** How long a CLI gets to exit after SIGTERM before its group is killed (SIGKILL). */
export const KILL_GRACE_MS = 3_000;

export interface CliCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed (the question never goes through argv). */
  readonly input: string;
  /** SIGTERM → SIGKILL delay; default KILL_GRACE_MS. */
  readonly killGraceMs?: number;
  /** The model a remote runner builds its own arguments with (ADR 0020). */
  readonly model?: string;
}

export interface CliProcess {
  /** stdout, one line at a time. */
  readonly lines: AsyncIterable<string>;
  /** Resolves with the exit code (null when killed by a signal). */
  readonly exit: Promise<number | null>;
  /** Ends the CLI and everything it started (its MCP clients, sub-processes). */
  kill(): void;
}

const hasExited = (child: ChildProcess): boolean =>
  child.exitCode !== null || child.signalCode !== null;

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try {
    // detached: the CLI leads its own process group, so -pid reaches its children too.
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/** SIGTERM now, SIGKILL after the grace period if the CLI is still running. */
function killTree(child: ChildProcess, graceMs: number): void {
  if (hasExited(child)) return;
  signalGroup(child, 'SIGTERM');
  const timer = setTimeout(() => {
    if (!hasExited(child)) signalGroup(child, 'SIGKILL');
  }, graceMs);
  timer.unref();
  child.once('close', () => clearTimeout(timer));
}

/** Spawns an official CLI without a shell (argument array, threat model) in its own group. */
export function spawnCli(call: CliCall): CliProcess {
  const child = spawn(call.bin, [...call.args], {
    cwd: call.cwd,
    env: call.env,
    stdio: ['pipe', 'pipe', 'ignore'],
    detached: true,
  });
  const exit = new Promise<number | null>((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('close', (code) => resolve(code));
  });
  const graceMs = call.killGraceMs ?? KILL_GRACE_MS;
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(call.input);
  if (!child.stdout) {
    // Never leave a started CLI behind when it cannot be read.
    killTree(child, graceMs);
    throw new Error(`${call.bin} started without stdout`);
  }
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return { lines, exit, kill: () => killTree(child, graceMs) };
}

/**
 * The only server variables a subscription CLI receives (ND-05, BR-7): what it needs to
 * run and find its own login (HOME, USER, the Keychain on macOS), the locale and proxy
 * settings. API credentials and every other server variable stay out.
 */
const CLI_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'TMPDIR',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'CLAUDE_CONFIG_DIR',
  // The container pins the CLI's version; it must not try to update itself (ADR 0010).
  'DISABLE_AUTOUPDATER',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
] as const;

/** The allowlisted part of the server's environment (AC-7: never an API key). */
export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set<string>(CLI_ENV_ALLOWLIST);
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name, value]) => allowed.has(name) && value !== undefined,
    ),
  );
}
