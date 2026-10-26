import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UsageLog } from './usage-log.js';

describe('UsageLog (KBC-006 FR-3)', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    }),
  );

  it('posts each event with the session of this page load', () => {
    const log = TestBed.inject(UsageLog);
    const http = TestBed.inject(HttpTestingController);
    log.track({ type: 'ai_cancel' });
    log.track({ type: 'open_doc', position: 2 });
    const [first, second] = http.match('/api/v1/events');
    expect(first?.request.method).toBe('POST');
    expect(first?.request.body).toEqual({
      sessionId: log.sessionId,
      event: { type: 'ai_cancel' },
    });
    expect(second?.request.body.sessionId).toBe(log.sessionId);
  });

  it('swallows a failed post (AC-4)', () => {
    const log = TestBed.inject(UsageLog);
    log.track({ type: 'ai_cancel' });
    expect(() =>
      TestBed.inject(HttpTestingController)
        .expectOne('/api/v1/events')
        .flush('x', { status: 500, statusText: 'Server Error' }),
    ).not.toThrow();
  });
});
