import { readFile, readdir } from 'node:fs/promises';

/** One process as /proc/<pid>/stat tells it: its parent and its start time (clock ticks). */
export interface ProcessEntry {
  readonly parent: number;
  readonly start: string;
}

/**
 * Parses /proc/<pid>/stat: after the command in parentheses (which may hold spaces or ')'),
 * field 4 is the parent pid and field 22 the start time.
 */
export function parseStat(stat: string): ProcessEntry | null {
  const close = stat.lastIndexOf(')');
  if (close < 0) return null;
  const fields = stat.slice(close + 2).split(' ');
  const parent = Number(fields[1]);
  const start = fields[19];
  if (!Number.isInteger(parent) || start === undefined) return null;
  return { parent, start };
}

/** The deepest process chain the container may have (its pids_limit is 256). */
const MAX_HOPS = 512;

/**
 * Whether a process came from a former turn and must go (ADR 0020). Kept: init (pid 1), the
 * runner and its descendants (the current turn, `codex login status`), and what comes from
 * outside the container (`docker exec`, the healthcheck: parent 0). Everything else that
 * reaches init is a stray; so is a chain the snapshot cannot follow (a missing parent, too
 * deep): when unsure, it goes.
 */
export function isStray(
  tree: ReadonlyMap<number, ProcessEntry>,
  pid: number,
  runner: number,
): boolean {
  if (pid === 1 || pid === runner) return false;
  let current = pid;
  for (let hops = 0; hops < MAX_HOPS; hops += 1) {
    if (current === runner) return false;
    const entry = tree.get(current);
    if (entry === undefined) return true;
    if (entry.parent === 0) return false;
    if (entry.parent === 1) return true;
    current = entry.parent;
  }
  return true;
}

/** Every process this user can see, by pid (Linux /proc). */
export async function processTree(
  proc = '/proc',
): Promise<Map<number, ProcessEntry>> {
  const tree = new Map<number, ProcessEntry>();
  for (const name of await readdir(proc)) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await readFile(`${proc}/${name}/stat`, 'utf8').catch(() => '');
    const entry = parseStat(stat);
    if (entry) tree.set(Number(name), entry);
  }
  return tree;
}

/** Kills the pid only if it is still the same process (a recycled pid is left alone). */
async function killIfSame(
  proc: string,
  pid: number,
  start: string,
): Promise<void> {
  const now = parseStat(
    await readFile(`${proc}/${pid}/stat`, 'utf8').catch(() => ''),
  );
  if (now?.start !== start) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

/** How many times the reaper scans and kills before it gives up (and refuses the turn). */
const PASSES = 5;

/**
 * Kills every process a former turn left behind, with its whole family, and fails closed: if
 * strays remain after the passes (a process that keeps forking), it throws and the turn does
 * not start, so no survivor ever reads the next turn's token (ADR 0020).
 */
export async function reapStrays(
  runner = process.pid,
  proc = '/proc',
): Promise<void> {
  for (let pass = 0; pass < PASSES; pass += 1) {
    const tree = await processTree(proc);
    const strays = [...tree].filter(([pid]) => isStray(tree, pid, runner));
    if (strays.length === 0) return;
    for (const [pid, { start }] of strays) await killIfSame(proc, pid, start);
  }
  const tree = await processTree(proc);
  if ([...tree.keys()].some((pid) => isStray(tree, pid, runner)))
    throw new Error('A former turn left processes that would not stop');
}
