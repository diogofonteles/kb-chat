import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  ApplicationRef,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { levelChoicesOf } from './level-choices.js';

const LEVELS = (topic: string) =>
  `/api/v1/topics/${encodeURIComponent(topic)}/media/levels`;

describe('levelChoicesOf (KBC-105, review round 3)', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }),
  );

  it('remembers a collection without levels with no field on the screen', async () => {
    const topic = signal('hermetismo');
    const choices = TestBed.runInInjectionContext(() =>
      levelChoicesOf(topic, (slug) => slug.split('/')[0] ?? slug),
    );
    const http = TestBed.inject(HttpTestingController);
    TestBed.tick();
    http
      .expectOne(LEVELS('hermetismo'))
      .flush({ collection: 'hermetismo', levels: [] });
    await TestBed.inject(ApplicationRef).whenStable();

    topic.set('hermetismo/aulas');
    TestBed.tick();
    http
      .expectOne(LEVELS('hermetismo/aulas'))
      .flush(null, { status: 503, statusText: 'Down' });
    await TestBed.inject(ApplicationRef).whenStable();

    // Nothing ever read `shown` here: the send's answer stands on its own.
    expect(choices.failed()).toBe(true);
    expect(choices.failedWhereLevelsMayBe('hermetismo')).toBe(false);
    expect(choices.failedWhereLevelsMayBe('udv')).toBe(true);
  });
});
