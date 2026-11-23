import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MARK_PLAYED_MAX } from '@kb-chat/contracts';
import { firstValueFrom } from 'rxjs';
import { LibraryApi, MARK_PLAYED_URL, batchesOf } from './library-api.js';

const ids = (count: number) =>
  Array.from({ length: count }, (_, n) => `id-${n + 1}`);

describe('LibraryApi marking in batches (KBC-051 FR-3)', () => {
  it('splits the ids into the API limit of 200, in order', () => {
    expect(MARK_PLAYED_MAX).toBe(200);
    const batches = batchesOf(ids(450));
    expect(batches.map((batch) => batch.length)).toEqual([200, 200, 50]);
    expect(batches.flat()).toEqual(ids(450));
  });

  it('sends 250 ids as 200 then 50, one request after the other', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const api = TestBed.inject(LibraryApi);
    const http = TestBed.inject(HttpTestingController);
    const outcome = firstValueFrom(api.markPlayedInBatches(ids(250), true));

    const first = http.expectOne(MARK_PLAYED_URL);
    expect(first.request.body).toEqual({ ids: ids(200), played: true });
    http.expectNone(MARK_PLAYED_URL);
    first.flush({ applied: [], marks: [] });
    const second = http.expectOne(MARK_PLAYED_URL);
    expect(second.request.body).toEqual({
      ids: ids(250).slice(200),
      played: true,
    });
    second.flush({ applied: [], marks: [] });

    expect((await outcome).unsent).toEqual([]);
    http.verify();
  });
});
