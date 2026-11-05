import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { ListeningApi, PREFERENCES_URL } from './listening-api.js';

const ID = '11111111-1111-4111-8111-111111111111';

function setup() {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting()],
  });
  return {
    api: TestBed.inject(ListeningApi),
    http: TestBed.inject(HttpTestingController),
  };
}

describe('ListeningApi (KBC-041)', () => {
  it('reads and saves the preferences through the contract', async () => {
    const { api, http } = setup();
    const read = firstValueFrom(api.preferences());
    http.expectOne({ method: 'GET', url: PREFERENCES_URL }).flush({
      speed: 1.5,
      showRemaining: false,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    await expect(read).resolves.toEqual({
      speed: 1.5,
      showRemaining: false,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    const saved = firstValueFrom(api.savePreferences({ speed: 2 }));
    const put = http.expectOne({ method: 'PUT', url: PREFERENCES_URL });
    expect(put.request.body).toEqual({ speed: 2 });
    put.flush({
      speed: 2,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    await expect(saved).resolves.toEqual({
      speed: 2,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
  });

  it('refuses preferences outside the contract', async () => {
    const { api, http } = setup();
    const read = firstValueFrom(api.preferences());
    http.expectOne(PREFERENCES_URL).flush({
      speed: 3,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
    });
    await expect(read).rejects.toThrow();
  });

  it('saves a position as whole milliseconds and reads what the server keeps', async () => {
    const { api, http } = setup();
    const saved = firstValueFrom(
      api.saveProgress(ID, { positionMs: 23_456.7, basedOn: null }),
    );
    const put = http.expectOne({
      method: 'PUT',
      url: `/api/v1/media/${ID}/progress`,
    });
    expect(put.request.body).toEqual({ positionMs: 23_456, basedOn: null });
    expect(put.request.keepalive).toBe(false);
    const kept = {
      positionMs: 23_456,
      completedAt: null,
      positionUpdatedAt: '2026-10-29T12:00:00.000Z',
    };
    put.flush(kept);
    await expect(saved).resolves.toEqual(kept);
  });

  it('names the cut the position was read on, for the server to translate it (KBC-073 BR-3)', () => {
    const { api, http } = setup();
    api
      .saveProgress(ID, { positionMs: 9_613, basedOn: null, fileVersion: 1 })
      .subscribe();
    const put = http.expectOne(`/api/v1/media/${ID}/progress`);
    expect(put.request.body).toEqual({
      positionMs: 9_613,
      basedOn: null,
      fileVersion: 1,
    });
  });

  it('can send one that outlives the page (FR-3)', () => {
    const { api, http } = setup();
    api
      .saveProgress(
        ID,
        { positionMs: 61_000.9, basedOn: '2026-10-29T12:00:00.000Z' },
        { keepalive: true },
      )
      .subscribe();
    const put = http.expectOne(`/api/v1/media/${ID}/progress`);
    expect(put.request.keepalive).toBe(true);
    expect(put.request.body).toEqual({
      positionMs: 61_000,
      basedOn: '2026-10-29T12:00:00.000Z',
    });
  });
});
