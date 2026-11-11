/**
 * One queue for the writes of the two levels services (KBC-107 review R1-7): scale changes
 * (and the first scale's seed), documents' levels and the catalog's reconciles run one after
 * the other, so a level moved or deleted never slips between a check and the write that
 * relies on it. A person's level is not here: PeopleService writes people.json in its own
 * queue, and a request checks the person's level when it starts.
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
