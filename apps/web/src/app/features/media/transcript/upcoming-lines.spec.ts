import { linesWithin, UpcomingLines } from './upcoming-lines.js';

/** An IntersectionObserver the test drives. */
class FakeObserver {
  static made: FakeObserver[] = [];
  readonly watched: Element[] = [];
  disconnected = false;
  constructor(
    readonly report: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    FakeObserver.made.push(this);
  }
  observe(target: Element) {
    this.watched.push(target);
  }
  disconnect() {
    this.disconnected = true;
  }
  near(lines: readonly Element[], isIntersecting = true) {
    this.report(
      lines.map(
        (target) => ({ target, isIntersecting }) as IntersectionObserverEntry,
      ),
      this as unknown as IntersectionObserver,
    );
  }
}

const Observer = FakeObserver as unknown as typeof IntersectionObserver;

/** Lines 40 px tall, one under the other; `hidden` ones are folded and have no box. */
function linesOf(count: number, hidden: readonly number[] = []) {
  return Array.from({ length: count }, (_, at) => {
    const line = document.createElement('li');
    line.hidden = hidden.includes(at);
    Object.defineProperty(line, 'offsetTop', {
      get: () => (line.hidden ? 0 : at * 40),
    });
    Object.defineProperty(line, 'offsetHeight', {
      get: () => (line.hidden ? 0 : 40),
    });
    return line;
  });
}

const faint = (lines: readonly HTMLElement[]) =>
  lines.map((line) => line.classList.contains('upcoming'));
const rightFor = (lines: readonly HTMLElement[], heard: number) =>
  lines.map((_, at) => heard >= 0 && at > heard);

describe('UpcomingLines (KBC-163)', () => {
  let tasks: (() => void)[] = [];
  let cancelled = 0;
  const later = (task: () => void) => {
    tasks.push(task);
    return () => {
      cancelled++;
      tasks = tasks.filter((one) => one !== task);
    };
  };
  /** Runs one task of the background pass; how many lines changed in it. */
  const step = (lines: readonly HTMLElement[]) => {
    const before = faint(lines);
    tasks.shift()?.();
    return faint(lines).filter((one, at) => one !== before[at]).length;
  };

  beforeEach(() => {
    FakeObserver.made = [];
    tasks = [];
    cancelled = 0;
  });

  it('without an observer, sets every line at once', () => {
    const lines = linesOf(10);
    const upcoming = new UpcomingLines(undefined, later);
    upcoming.watch(lines, document.createElement('ol'));
    upcoming.show(3);
    expect(faint(lines)).toEqual(rightFor(lines, 3));
    upcoming.show(-1);
    expect(faint(lines).some(Boolean)).toBe(false);
    expect(tasks).toHaveLength(0);
  });

  it('observes the lines in their list, and a new list or new lines replace the observer', () => {
    const lines = linesOf(5);
    const list = document.createElement('ol');
    const upcoming = new UpcomingLines(Observer, later);
    upcoming.watch(lines, list);
    const [first] = FakeObserver.made;
    expect(first?.watched).toEqual(lines);
    expect(first?.options).toEqual({ root: list, rootMargin: '50% 0px' });
    // The same lines in another <ol>: another root.
    const other = document.createElement('ol');
    upcoming.watch(lines, other);
    const second = FakeObserver.made[1];
    expect(first?.disconnected).toBe(true);
    expect(second?.options.root).toBe(other);
    expect(second?.watched).toEqual(lines);
    const fresh = linesOf(3);
    upcoming.watch(fresh, other);
    expect(second?.disconnected).toBe(true);
    expect(FakeObserver.made[2]?.watched).toEqual(fresh);
  });

  it('sets the lines near the view at once and the others in a later pass, a chunk at a time', () => {
    const lines = linesOf(1_000);
    const upcoming = new UpcomingLines(Observer, later);
    upcoming.watch(lines, document.createElement('ol'));
    const observer = FakeObserver.made[0] as FakeObserver;
    observer.near(lines.slice(0, 10));
    upcoming.show(4);
    expect(faint(lines).slice(0, 10)).toEqual(rightFor(lines, 4).slice(0, 10));
    expect(faint(lines)[500]).toBe(false);
    // ~1 000 lines change: no task sets more than 200.
    const changes: number[] = [];
    while (tasks.length > 0) changes.push(step(lines));
    expect(Math.max(...changes)).toBeLessThanOrEqual(200);
    expect(faint(lines)).toEqual(rightFor(lines, 4));
    // A step forward changes only the line now heard.
    upcoming.show(5);
    expect(faint(lines)).toEqual(rightFor(lines, 5));
  });

  it('keeps right the lines where the list went, until it goes elsewhere', () => {
    const lines = linesOf(200);
    const upcoming = new UpcomingLines(Observer, later);
    upcoming.watch(lines, document.createElement('ol'));
    upcoming.settle(10, 150, 170);
    const expected = rightFor(lines, 10);
    expect(faint(lines).slice(150, 171)).toEqual(expected.slice(150, 171));
    expect(faint(lines)[100]).toBe(false);
    // The line heard moves past them before the observer reports: they follow.
    upcoming.show(160);
    expect(faint(lines).slice(150, 171)).toEqual(
      rightFor(lines, 160).slice(150, 171),
    );
  });

  it('stops: no observer, no pass left', () => {
    const lines = linesOf(50);
    const upcoming = new UpcomingLines(Observer, later);
    upcoming.watch(lines, document.createElement('ol'));
    upcoming.show(2);
    expect(tasks).toHaveLength(1);
    upcoming.stop();
    expect(FakeObserver.made[0]?.disconnected).toBe(true);
    expect(cancelled).toBe(1);
    expect(tasks).toHaveLength(0);
  });
});

describe('linesWithin (KBC-163)', () => {
  it('finds the lines that meet a band, passing over the folded ones', () => {
    const lines = linesOf(100, [41, 42, 43, 60]);
    // 1 000 to 1 800 px: lines 25 (1 000–1 040) to 44 (1 760–1 800).
    expect(linesWithin(lines, 1_000, 1_800)).toEqual({ from: 25, to: 44 });
    // An edge inside a line takes it.
    expect(linesWithin(lines, 1_010, 1_790)).toEqual({ from: 25, to: 44 });
    expect(linesWithin(lines, 2_380, 2_430)).toEqual({ from: 59, to: 59 });
    expect(linesWithin(lines, -500, 30)).toEqual({ from: 0, to: 0 });
    expect(linesWithin(lines, 5_000, 6_000)).toBeNull();
    expect(linesWithin([], 0, 100)).toBeNull();
  });
});
