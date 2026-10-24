import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { HttpEventType } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { researchEventSchema, type ResearchEvent } from '@kb-chat/contracts';
import { ResearchApi, newEvents } from './research-api.js';

const sse = (...events: object[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('');

describe('newEvents', () => {
  it('returns complete events after the ones already seen', () => {
    const text = sse(
      { type: 'sources', sources: [] },
      { type: 'token', text: 'Oi' },
    );
    expect(newEvents(researchEventSchema, text, 0)).toHaveLength(2);
    expect(newEvents(researchEventSchema, text, 1)).toEqual([
      { type: 'token', text: 'Oi' },
    ]);
  });

  it('waits for an event cut in the middle', () => {
    const text = `${sse({ type: 'token', text: 'a' })}data: {"type":"tok`;
    expect(newEvents(researchEventSchema, text, 0)).toEqual([
      { type: 'token', text: 'a' },
    ]);
  });
});

describe('ResearchApi.research', () => {
  it('posts the question with the history and emits each event once', () => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const received: ResearchEvent[] = [];
    TestBed.inject(ResearchApi)
      .research('hermetismo', {
        question: 'e o terceiro?',
        history: [{ question: 'quais são?', answer: 'Sete [1].' }],
      })
      .subscribe((event) => received.push(event));
    const http = TestBed.inject(HttpTestingController);
    const request = http.expectOne('/api/v1/topics/hermetismo/research');
    expect(request.request.body).toEqual({
      question: 'e o terceiro?',
      history: [{ question: 'quais são?', answer: 'Sete [1].' }],
    });
    const first = sse({ type: 'step', step: { kind: 'search', text: 'B' } });
    request.event({
      type: HttpEventType.DownloadProgress,
      loaded: 1,
      partialText: first,
    });
    request.flush(`${first}${sse({ type: 'token', text: 'Oi' })}`);
    expect(received.map((event) => event.type)).toEqual(['step', 'token']);
    http.verify();
  });
});
