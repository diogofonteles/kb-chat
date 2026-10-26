import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { CliCall, CliProcess } from './cli-process.js';

/** The last line of a runner's answer: the CLI's exit code (ADR 0020). */
export const RUNNER_EXIT = 'kbchat.runner.exit';

/** The variable that carries the turn token to Codex (sent as `Authorization: Bearer`). */
export const CODEX_TOKEN_ENV = 'KB_CHAT_MCP_TOKEN';

/** The exit code a runner line carries, or undefined for a line of the CLI itself. */
export function exitCodeOf(line: string): number | null | undefined {
  if (!line.includes(RUNNER_EXIT)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  if (!('type' in parsed) || parsed.type !== RUNNER_EXIT) return undefined;
  return 'code' in parsed && typeof parsed.code === 'number'
    ? parsed.code
    : null;
}

interface RemoteTurn {
  readonly runnerUrl: string;
  readonly fetchImpl: typeof fetch;
  readonly call: CliCall;
  readonly signal: AbortSignal;
  /** Gets the exit code once known (-1: the runner could not run the turn). */
  readonly settle: (code: number | null) => void;
}

/** The CLI's own lines; the runner's last line settles the exit code. */
async function* cliLines(
  reader: AsyncIterable<string>,
  settle: (code: number | null) => void,
): AsyncIterable<string> {
  for await (const line of reader) {
    const code = exitCodeOf(line);
    if (code === undefined) yield line;
    else settle(code);
  }
  settle(null);
}

/** POSTs the turn and yields the CLI's lines; the runner's exit line settles the code. */
async function* turnLines(turn: RemoteTurn): AsyncIterable<string> {
  const { call } = turn;
  try {
    const response = await turn.fetchImpl(`${turn.runnerUrl}/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        args: call.args,
        input: call.input,
        token: call.env[CODEX_TOKEN_ENV] ?? '',
      }),
      signal: turn.signal,
    });
    if (!response.ok || !response.body) return turn.settle(-1);
    const reader = createInterface({
      input: Readable.fromWeb(response.body),
      crlfDelay: Infinity,
    });
    yield* cliLines(reader, turn.settle);
  } catch {
    // The runner is down, or the turn was stopped: like a CLI that could not start.
    turn.settle(-1);
  }
}

/**
 * A CLI run by the Codex sandbox runner instead of a local process (KBC-027, ADR 0020): the
 * arguments, the input and the turn token go over the internal network; nothing else of this
 * process's environment does. Aborting the request makes the runner stop the CLI.
 */
export const remoteCli =
  (runnerUrl: string, fetchImpl: typeof fetch = fetch) =>
  (call: CliCall): CliProcess => {
    const controller = new AbortController();
    let settle: (code: number | null) => void = () => undefined;
    const exit = new Promise<number | null>((resolve) => {
      settle = resolve;
    });
    const lines = turnLines({
      runnerUrl,
      fetchImpl,
      call,
      signal: controller.signal,
      settle: (code) => settle(code),
    });
    return { lines, exit, kill: () => controller.abort() };
  };
