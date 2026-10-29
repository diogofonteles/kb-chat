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
  afterEach(() => vi.unstubAllGlobals());

  it('reads and saves the preferences through the contract', async () => {
    const { api, http } = setup();
    const read = firstValueFrom(api.preferences());
    http
      .expectOne({ method: 'GET', url: PREFERENCES_URL })
      .flush({ speed: 1.5, showRemaining: false });
    await expect(read).resolves.toEqual({ speed: 1.5, showRemaining: false });
    const saved = firstValueFrom(
      api.savePreferences({ speed: 2, showRemaining: true }),
    );
    const put = http.expectOne({ method: 'PUT', url: PREFERENCES_URL });
    expect(put.request.body).toEqual({ speed: 2, showRemaining: true });
    put.flush({ speed: 2, showRemaining: true });
    await expect(saved).resolves.toEqual({ speed: 2, showRemaining: true });
  });

  it('refuses preferences outside the contract', async () => {
    const { api, http } = setup();
    const read = firstValueFrom(api.preferences());
    http.expectOne(PREFERENCES_URL).flush({ speed: 3, showRemaining: true });
    await expect(read).rejects.toThrow();
  });

  it('saves a position as whole milliseconds', async () => {
    const { api, http } = setup();
    const saved = firstValueFrom(api.saveProgress(ID, 23_456.7));
    const put = http.expectOne({
      method: 'PUT',
      url: `/api/v1/media/${ID}/progress`,
    });
    expect(put.request.body).toEqual({ positionMs: 23_456 });
    put.flush(null, { status: 204, statusText: 'No Content' });
    await expect(saved).resolves.toBeNull();
  });

  it('saves a position as the page closes with a request that outlives it (FR-3)', () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null)));
    vi.stubGlobal('fetch', fetch);
    const { api } = setup();
    api.saveProgressOnExit(ID, 61_000.9);
    expect(fetch).toHaveBeenCalledWith(`/api/v1/media/${ID}/progress`, {
      method: 'PUT',
      keepalive: true,
      credentials: 'same-origin',
      headers: {
        'content-type': 'application/json',
        'x-requested-with': 'kb-chat',
      },
      body: JSON.stringify({ positionMs: 61_000 }),
    });
  });
});
