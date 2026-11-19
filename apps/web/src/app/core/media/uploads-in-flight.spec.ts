import {
  DestroyRef,
  EnvironmentInjector,
  createEnvironmentInjector,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UploadsInFlight, type UploadInFlight } from './uploads-in-flight.js';

const sending = (key: string, loaded: number): UploadInFlight => ({
  key,
  title: `Palestra ${key}`,
  loaded,
  total: 100,
});

/** A panel's lifetime: its own injector, destroyed when the panel goes. */
const aPanel = () =>
  createEnvironmentInjector([], TestBed.inject(EnvironmentInjector));

describe('UploadsInFlight (v2 media-upload-sending)', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }),
  );

  it("follows each panel's sends as they go, with no effect to run first", () => {
    const inFlight = TestBed.inject(UploadsInFlight);
    const first = signal<readonly UploadInFlight[]>([sending('a', 10)]);
    const second = signal<readonly UploadInFlight[]>([]);
    inFlight.register(first, aPanel().get(DestroyRef));
    inFlight.register(second, aPanel().get(DestroyRef));
    expect(inFlight.items().map((one) => one.loaded)).toEqual([10]);

    first.set([sending('a', 60)]);
    second.set([sending('b', 5)]);

    expect(inFlight.items().map((one) => [one.key, one.loaded])).toEqual([
      ['a', 60],
      ['b', 5],
    ]);
  });

  it('forgets a panel once it is destroyed, and only that one', () => {
    const inFlight = TestBed.inject(UploadsInFlight);
    const gone = aPanel();
    inFlight.register(signal([sending('a', 10)]), gone.get(DestroyRef));
    inFlight.register(signal([sending('b', 20)]), aPanel().get(DestroyRef));
    expect(inFlight.items()).toHaveLength(2);

    gone.destroy();

    expect(inFlight.items().map((one) => one.key)).toEqual(['b']);
  });
});
