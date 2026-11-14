import {
  EnvironmentInjector,
  createEnvironmentInjector,
  provideZonelessChangeDetection,
  runInInjectionContext,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BusyWork } from './busy-work.js';

describe('BusyWork (KBC-123)', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection()],
    }),
  );

  it('is busy while any key is held', () => {
    const work = TestBed.inject(BusyWork);
    expect(work.busy()).toBe(false);
    work.hold('upload-1');
    work.hold('upload-2');
    work.release('upload-1');
    expect(work.busy()).toBe(true);
    work.release('upload-2');
    expect(work.busy()).toBe(false);
  });

  it('follows a busy signal until its owner is destroyed', () => {
    const work = TestBed.inject(BusyWork);
    const playing = signal(false);
    const owner = createEnvironmentInjector(
      [],
      TestBed.inject(EnvironmentInjector),
    );
    runInInjectionContext(owner, () => work.holdWhile(playing));
    expect(work.busy()).toBe(false);
    playing.set(true);
    expect(work.busy()).toBe(true);
    owner.destroy();
    expect(work.busy()).toBe(false);
  });
});
