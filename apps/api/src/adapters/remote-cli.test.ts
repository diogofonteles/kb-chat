import { describe, expect, it } from 'vitest';
import { parseCodexLine } from './codex-cli-runner.js';
import { RUNNER_UNAVAILABLE, remoteCli } from './remote-cli.js';

const call = {
  bin: 'codex',
  args: [],
  cwd: '/',
  env: { KB_CHAT_MCP_TOKEN: 'x'.repeat(32) },
  input: 'q',
};

async function linesOf(fetchImpl: typeof fetch, abort = false) {
  const cli = remoteCli('http://runner', fetchImpl)(call);
  if (abort) cli.kill();
  const lines: string[] = [];
  for await (const line of cli.lines) lines.push(line);
  return { lines, exit: await cli.exit };
}

describe('remoteCli (ADR 0020, review R7, R11)', () => {
  it('says the sandbox is unavailable when the runner refuses or fails', async () => {
    for (const status of [403, 500, 503]) {
      const { lines, exit } = await linesOf(
        async () => new Response('{}', { status }),
      );
      expect(lines).toEqual([JSON.stringify({ type: RUNNER_UNAVAILABLE })]);
      expect(parseCodexLine(lines[0] ?? '')).toEqual({
        result: { ok: false, code: 'CLI_MISSING' },
      });
      expect(exit).toBe(-1);
    }
  });

  it('says nothing for a request of ours the runner found malformed', async () => {
    const { lines } = await linesOf(
      async () => new Response('{}', { status: 400 }),
    );
    expect(lines).toEqual([]);
  });

  it('says nothing when the turn was stopped', async () => {
    const { lines } = await linesOf(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const stop = () => reject(new DOMException('aborted', 'AbortError'));
          if (init?.signal?.aborted) stop();
          else init?.signal?.addEventListener('abort', stop);
        }),
      true,
    );
    expect(lines).toEqual([]);
  });

  it('relays the CLI lines and reads the exit code from the runner', async () => {
    const body = `${JSON.stringify({ type: 'turn.started' })}\n${JSON.stringify({ type: 'kbchat.runner.exit', code: 0 })}\n`;
    const { lines, exit } = await linesOf(async () => new Response(body));
    expect(lines).toEqual([JSON.stringify({ type: 'turn.started' })]);
    expect(exit).toBe(0);
  });
});
