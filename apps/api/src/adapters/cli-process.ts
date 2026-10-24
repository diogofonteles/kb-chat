import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface CliCall {
  readonly bin: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Written to stdin, which is then closed (the question never goes through argv). */
  readonly input: string;
}

export interface CliProcess {
  /** stdout, one line at a time. */
  readonly lines: AsyncIterable<string>;
  /** Resolves with the exit code (null when killed by a signal). */
  readonly exit: Promise<number | null>;
  /** Ends the CLI and everything it started (its MCP clients, sub-processes). */
  kill(): void;
}

function killTree(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    // detached: the CLI leads its own process group, so -pid reaches its children too.
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
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
  child.stdin?.on('error', () => undefined);
  child.stdin?.end(call.input);
  if (!child.stdout) throw new Error(`${call.bin} started without stdout`);
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  return { lines, exit, kill: () => killTree(child) };
}

/** Variables never handed to a subscription CLI: they would bill an API account (BR-7). */
const API_CREDENTIALS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
] as const;

/** The server's environment minus API credentials (AC-7). */
export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const blocked = new Set<string>(API_CREDENTIALS);
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !blocked.has(name)),
  );
}
