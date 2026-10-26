import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import type { CliCall, CliProcess } from './cli-process.js';

/** The last line of a runner's answer: the CLI's exit code (ADR 0020). */
export const RUNNER_EXIT = 'kbchat.runner.exit';

/** The variable that carries the turn token to Codex (sent as `Authorization: Bearer`). */
export const CODEX_TOKEN_ENV = 'KB_CHAT_MCP_TOKEN';

const exitCodeOf = (line: string): number | null | undefined => {
  if (!line.includes(RUNNER_EXIT)) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'type' in parsed &&
      parsed.type === RUNNER_EXIT
    )
      return 'code' in parsed && typeof parsed.code === 'number'
        ? parsed.code
        : null;
  } catch {
    return undefined;
  }
  return undefined;
};

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
    async function* lines(): AsyncIterable<string> {
      try {
        const response = await fetchImpl(`${runnerUrl}/turn`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            args: call.args,
            input: call.input,
            token: call.env[CODEX_TOKEN_ENV] ?? '',
          }),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          settle(-1);
          return;
        }
        const reader = createInterface({
          input: Readable.fromWeb(response.body),
          crlfDelay: Infinity,
        });
        for await (const line of reader) {
          const code = exitCodeOf(line);
          if (code === undefined) yield line;
          else settle(code);
        }
        settle(null);
      } catch {
        // The runner is down, or the turn was stopped: like a CLI that could not start.
        settle(-1);
      }
    }
    return { lines: lines(), exit, kill: () => controller.abort() };
  };
