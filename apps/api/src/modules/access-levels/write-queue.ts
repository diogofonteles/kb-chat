/**
 * One queue for every write of levels (KBC-107 review R1-7): scales, people's levels,
 * documents' levels and the catalog's reconciles run one after the other, so a level moved or
 * deleted never slips between a check and the write that relies on it.
 */
export class LevelWriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /** Resolves once every write queued so far is done (whatever its outcome). */
  settled(): Promise<void> {
    return this.tail.then(() => undefined);
  }
}
