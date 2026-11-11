/** One write of a multi-store change, and how to put it back. */
export interface UndoableStep {
  /** What the log names when its undo fails. */
  readonly name: string;
  /** Writes; resolves with the undo of what it wrote. */
  readonly apply: () => Promise<() => Promise<void>>;
}

interface UndoLog {
  error(fields: object, message: string): void;
}

/** Undoes the steps already written, newest first; an undo that fails is logged, the rest still run. */
async function rollBack(
  done: readonly {
    readonly name: string;
    readonly undo: () => Promise<void>;
  }[],
  log: UndoLog,
): Promise<void> {
  for (const step of [...done].reverse())
    await step.undo().catch((err: unknown) => {
      log.error(
        { err, step: step.name },
        'level change rolled back incompletely',
      );
    });
}

/**
 * KBC-108 NFR-2: the stores of a scale change (media.db, document-levels.json, people.json,
 * access-levels.json, the audit) share no transaction, so each step returns its undo and a
 * failure in any of them puts every earlier one back before the error goes on.
 */
export async function applyAll(
  steps: readonly UndoableStep[],
  log: UndoLog,
): Promise<void> {
  const done: { readonly name: string; readonly undo: () => Promise<void> }[] =
    [];
  try {
    for (const step of steps)
      done.push({ name: step.name, undo: await step.apply() });
  } catch (err) {
    await rollBack(done, log);
    throw err;
  }
}
