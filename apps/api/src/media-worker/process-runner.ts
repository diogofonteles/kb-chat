import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  /** The last lines of stderr, for the log (ffmpeg writes its errors there). */
  readonly stderrTail: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface RunOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  /** Each stdout line as it arrives (ffmpeg's -progress). */
  readonly onLine?: (line: string) => void;
  /** Each stderr line as it arrives (ffmpeg's filter reports, e.g. silencedetect). */
  readonly onErrorLine?: (line: string) => void;
  /** Raw stdout (decoded samples): read here and neither kept nor split into lines. */
  readonly onData?: (chunk: Buffer) => void;
}

interface Collected {
  stdout: string;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
}

const STDERR_TAIL = 4_000;

/**
 * Runs a program by absolute path, without a shell, with a time limit (ADR 0022 §3). The
 * child is killed on timeout or when `signal` aborts; the promise never rejects.
 */
export function runProcess(
  bin: string,
  args: readonly string[],
  options: RunOptions,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const state: Collected = {
      stdout: '',
      stderr: '',
      timedOut: false,
      aborted: false,
    };
    collectOutput(child, state, options);
    const release = watchForKill(child, { state, options });
    let settled = false;
    // 'error' (the program did not start) may be followed by 'close': answer once.
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      release();
      resolve(resultOf(code, state));
    };
    child.once('error', (err) => {
      state.stderr += err.message;
      settle(null);
    });
    child.once('close', (code) => settle(code));
  });
}

const resultOf = (code: number | null, state: Collected): ProcessResult => ({
  code,
  stdout: state.stdout,
  stderrTail: state.stderr.slice(-STDERR_TAIL),
  timedOut: state.timedOut,
  aborted: state.aborted,
});

/** Kills the child on timeout or abort; returns what stops watching. */
function watchForKill(
  child: ChildProcess,
  watch: { state: Collected; options: RunOptions },
): () => void {
  const { state, options } = watch;
  const kill = (reason: 'timedOut' | 'aborted') => {
    state[reason] = true;
    child.kill('SIGKILL');
  };
  const timer = setTimeout(() => kill('timedOut'), options.timeoutMs);
  const onAbort = () => kill('aborted');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) kill('aborted');
  return () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  };
}

function collectOutput(
  child: ChildProcess,
  state: Collected,
  sink: Pick<RunOptions, 'onLine' | 'onErrorLine' | 'onData'>,
): void {
  const { onData } = sink;
  if (onData) child.stdout?.on('data', onData);
  else if (child.stdout)
    createInterface({ input: child.stdout }).on('line', (line) => {
      state.stdout += `${line}\n`;
      sink.onLine?.(line);
    });
  const { onErrorLine } = sink;
  if (child.stderr && onErrorLine)
    createInterface({ input: child.stderr }).on('line', onErrorLine);
  child.stderr?.on('data', (chunk: Buffer) => {
    state.stderr = (state.stderr + chunk.toString()).slice(-STDERR_TAIL * 2);
  });
}
