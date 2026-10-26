/**
 * A push-based async iterable for one consumer: producers running in parallel (the
 * sub-researchers of a delegation, ADR 0014) push events that the runner streams in order.
 * `end` finishes the iteration once drained.
 */
export class EventPipe<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: (() => void) | null = null;
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    this.items.push(item);
    this.wake();
  }

  end(): void {
    this.ended = true;
    this.wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      const item = this.items.shift();
      if (item !== undefined) yield item;
      else if (this.ended) return;
      else await new Promise<void>((resolve) => (this.waiting = resolve));
    }
  }

  private wake(): void {
    const resolve = this.waiting;
    this.waiting = null;
    resolve?.();
  }
}
