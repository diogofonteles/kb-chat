/**
 * One queue for every level write (KBC-107 review R1-7, KBC-109 R1-6, KBC-108): scale changes
 * (the first scale's seed, a delete, every level taken away), documents' levels, the catalog's
 * reconciles and people's levels (the person editor, invitations, profiles and the people bulk
 * through `PersonLevelRules.serial`) run one after the other, so a level moved or deleted never
 * slips between a check and the write that relies on it. Audios are not here: an upload or an
 * edit checks and writes its level in one synchronous run, and a delete writes the scale first.
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
