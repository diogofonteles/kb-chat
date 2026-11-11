/** Steps kept per session (BR-6). */
export const HISTORY_LIMIT = 100;

/**
 * Undo and redo over whole states (FR-7): the states are immutable, so a step is a
 * reference. A new change forgets what could be redone; the oldest step goes past the limit.
 */
export class UndoHistory<T> {
  private past: readonly T[] = [];
  private future: readonly T[] = [];

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  record(previous: T): void {
    this.past = [...this.past, previous].slice(-HISTORY_LIMIT);
    this.future = [];
  }

  undo(current: T): T | null {
    const previous = this.past.at(-1);
    if (previous === undefined) return null;
    this.past = this.past.slice(0, -1);
    this.future = [current, ...this.future];
    return previous;
  }

  redo(current: T): T | null {
    const next = this.future[0];
    if (next === undefined) return null;
    this.future = this.future.slice(1);
    this.past = [...this.past, current];
    return next;
  }
}
