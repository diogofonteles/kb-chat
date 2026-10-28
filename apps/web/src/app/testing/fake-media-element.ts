/**
 * A real `<audio>` or `<video>` element (jsdom) whose playback is driven by the test: jsdom
 * does not play media, so `play`, `pause`, `load` and the time properties are replaced on
 * the instance, and the test fires the events the browser would.
 */
export interface FakeMedia {
  readonly element: HTMLMediaElement;
  /** How the next `play()` answers. */
  playAnswer: 'resolve' | 'not-allowed' | 'abort' | 'fail';
  readonly calls: string[];
  emit(name: keyof HTMLMediaElementEventMap): void;
  setDuration(seconds: number): void;
  setCurrentTime(seconds: number): void;
  setBuffered(ranges: readonly (readonly [number, number])[]): void;
  setError(code: number | null): void;
}

interface FakeValues {
  duration: number;
  currentTime: number;
  buffered: (readonly [number, number])[];
  error: MediaError | null;
}

export function fakeMediaElement(tag: 'audio' | 'video' = 'audio'): FakeMedia {
  const element = document.createElement(tag);
  const values: FakeValues = {
    duration: Number.NaN,
    currentTime: 0,
    buffered: [],
    error: null,
  };
  const fake: FakeMedia = {
    element,
    playAnswer: 'resolve',
    calls: [],
    emit: (name) => element.dispatchEvent(new Event(name)),
    setDuration: (seconds) => (values.duration = seconds),
    setCurrentTime: (seconds) => (values.currentTime = seconds),
    setBuffered: (ranges) => (values.buffered = [...ranges]),
    setError: (code) =>
      (values.error =
        code === null ? null : ({ code, message: '' } as MediaError)),
  };
  defineTimeProperties(fake, values);
  fakePlayback(fake);
  return fake;
}

function defineTimeProperties(fake: FakeMedia, values: FakeValues): void {
  Object.defineProperties(fake.element, {
    duration: { get: () => values.duration },
    currentTime: {
      get: () => values.currentTime,
      set: (seconds: number) => {
        fake.calls.push(`seek:${seconds}`);
        values.currentTime = seconds;
      },
    },
    buffered: {
      get: () => ({
        length: values.buffered.length,
        start: (i: number) => values.buffered[i]?.[0] ?? 0,
        end: (i: number) => values.buffered[i]?.[1] ?? 0,
      }),
    },
    error: { get: () => values.error },
  });
}

const PLAY_ANSWERS: Record<FakeMedia['playAnswer'], () => Promise<void>> = {
  resolve: () => Promise.resolve(),
  'not-allowed': () =>
    Promise.reject(new DOMException('no gesture', 'NotAllowedError')),
  abort: () => Promise.reject(new DOMException('replaced', 'AbortError')),
  fail: () => Promise.reject(new DOMException('cannot', 'NotSupportedError')),
};

function fakePlayback(fake: FakeMedia): void {
  const { element } = fake;
  element.play = () => {
    fake.calls.push('play');
    return PLAY_ANSWERS[fake.playAnswer]();
  };
  element.pause = () => void fake.calls.push('pause');
  element.load = () =>
    void fake.calls.push(`load:${element.getAttribute('src') ?? ''}`);
}
