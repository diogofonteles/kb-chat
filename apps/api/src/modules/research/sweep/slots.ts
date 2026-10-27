/**
 * At most `size` jobs run at once; the others wait in order (the sweep's batches,
 * KBC-030; formerly the sub-researchers of ADR 0014).
 */
export class Slots {
  private free: number;
  private readonly waiting: (() => void)[] = [];

  constructor(size: number) {
    this.free = Math.max(1, size);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.free > 0) this.free -= 1;
    else await new Promise<void>((resolve) => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.free += 1;
    }
  }
}
