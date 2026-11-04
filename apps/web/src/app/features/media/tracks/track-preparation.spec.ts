import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ApplicationRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { TrackPreparationStatus } from './track-preparation.js';

const ID = '11111111-1111-4111-8111-111111111111';
const URL = `/api/v1/media/${ID}/edit`;

const anEdit = (preparation: object | null) => ({
  mediaId: ID,
  version: 4,
  started: true,
  status: 'approved',
  step: 4,
  tracks: [],
  run: null,
  lastFailure: null,
  voices: [],
  approvedTracks: 12,
  transcriptChanged: false,
  preparation,
});

function setup() {
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_POLL_MS, useValue: 5 },
    ],
  });
  const fixture = TestBed.createComponent(TrackPreparationStatus);
  fixture.componentRef.setInput('mediaId', ID);
  return { fixture, http: TestBed.inject(HttpTestingController) };
}

/** The resource's request and answer take a pass of the app each. */
const settle = async () => {
  await Promise.resolve();
  TestBed.inject(ApplicationRef).tick();
  await Promise.resolve();
  TestBed.inject(ApplicationRef).tick();
};

const textOf = (fixture: { nativeElement: HTMLElement }) =>
  fixture.nativeElement.textContent?.trim() ?? '';

describe('TrackPreparationStatus (KBC-068 FR-1)', () => {
  it('counts the cuts while they are on the way, and says when they are done', async () => {
    const { fixture, http } = setup();
    await settle();
    http.expectOne(URL).flush(anEdit({ total: 12, done: 3, failed: 0 }));
    await settle();
    expect(textOf(fixture)).toBe('Preparando faixas: 3 de 12');
    await new Promise((resolve) => setTimeout(resolve, 20));
    http.expectOne(URL).flush(anEdit(null));
    await settle();
    expect(textOf(fixture)).toBe('12 faixas prontas');
  });

  it('says nothing about an approval that was already published', async () => {
    const { fixture, http } = setup();
    await settle();
    http.expectOne(URL).flush(anEdit(null));
    await settle();
    expect(textOf(fixture)).toBe('');
    await new Promise((resolve) => setTimeout(resolve, 20));
    http.expectNone(URL);
  });

  it('offers to try again what failed, with the version it read', async () => {
    const { fixture, http } = setup();
    await settle();
    http.expectOne(URL).flush(anEdit({ total: 12, done: 10, failed: 2 }));
    await settle();
    expect(textOf(fixture)).toContain('Não foi possível preparar 2 faixas');
    const button: HTMLButtonElement =
      fixture.nativeElement.querySelector('button');
    button.click();
    const retried = http.expectOne(`${URL}/retry-cuts`);
    expect(retried.request.headers.get('If-Match')).toBe('"4"');
    retried.flush({ version: 4 });
    await settle();
    http.expectOne(URL).flush(anEdit({ total: 12, done: 10, failed: 0 }));
    await settle();
    expect(textOf(fixture)).toBe('Preparando faixas: 10 de 12');
  });
});
