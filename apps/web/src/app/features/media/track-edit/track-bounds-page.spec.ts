import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  convertToParamMap,
  provideRouter,
} from '@angular/router';
import type { TrackEditView } from '@kb-chat/contracts';
import { of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MEDIA_ELEMENT_FACTORY } from '@core/media/media-engine.js';
import { fakeMediaElement } from '../../../testing/fake-media-element.js';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { TrackBoundsPage } from './track-bounds-page.js';

const ID = '11111111-1111-4111-8111-111111111111';
const RECORDING = '22222222-2222-4222-8222-222222222222';
const VIEW_URL = `/api/v1/media/${ID}/track-edit`;
const BOUNDS_URL = `/api/v1/media/${ID}/bounds`;

const CUT_RUNNING = {
  error: {
    code: 'MEDIA_CONFLICT',
    message: 'A cut of this track is on its way',
    details: { reason: 'cut-running' },
  },
};

const view = (over: Partial<TrackEditView> = {}): TrackEditView => ({
  mediaId: ID,
  recordingId: RECORDING,
  recordingTitle: 'Gravação',
  topic: 'hermetismo',
  version: 3,
  title: 'A faixa',
  summary: null,
  ordinal: 1,
  startMs: 0,
  endMs: 60_000,
  recordingDurationMs: 600_000,
  asker: { voice: null, speakerId: null, name: null },
  answerer: { voice: null, speakerId: null, name: null },
  cut: 'none',
  locked: false,
  tracks: [{ id: ID, ordinal: 1, title: 'A faixa', startMs: 0, endMs: 60_000 }],
  ...over,
});

describe('TrackBoundsPage (KBC-073)', () => {
  let http: HttpTestingController;
  let pollMs: number;

  beforeEach(() => {
    pollMs = 60_000;
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: MEDIA_POLL_MS, useFactory: () => pollMs },
        {
          provide: ActivatedRoute,
          useValue: { paramMap: of(convertToParamMap({ id: ID })) },
        },
        {
          provide: MEDIA_ELEMENT_FACTORY,
          useValue: () => fakeMediaElement().element,
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(track = view()) {
    const fixture = TestBed.createComponent(TrackBoundsPage);
    TestBed.tick();
    http.expectOne(VIEW_URL).flush(track);
    // The words, silences and waveform: the bar works without them.
    for (const pass of [1, 2]) {
      await Promise.resolve();
      TestBed.tick();
      http
        .match((request) => pass > 0 && request.method === 'GET')
        .forEach((one) => one.flush({}, { status: 404, statusText: 'None' }));
    }
    await fixture.whenStable();
    const root = fixture.nativeElement as HTMLElement;
    const button = (name: string) => {
      const found = [...root.querySelectorAll('button')].find(
        (one) => one.textContent?.trim() === name,
      );
      if (!found) throw new Error(`no button ${name}`);
      return found;
    };
    const click = async (name: string) => {
      button(name).click();
      await fixture.whenStable();
    };
    return { fixture, root, button, click };
  }

  async function conflicted() {
    const page = await open();
    await page.click('+0,5 s');
    await page.click('Salvar limites');
    http
      .expectOne({ method: 'PUT', url: BOUNDS_URL })
      .flush(null, { status: 412, statusText: 'Precondition Failed' });
    await page.fixture.whenStable();
    http
      .expectOne(VIEW_URL)
      .flush(view({ version: 4, startMs: 2_000, title: 'O título dela' }));
    await page.fixture.whenStable();
    return page;
  }

  it('saves what the handle says, with the version it read', async () => {
    const { click } = await open();
    await click('+0,5 s');

    await click('Salvar limites');

    const put = http.expectOne({ method: 'PUT', url: BOUNDS_URL });
    expect(put.request.body).toEqual({ startMs: 500, endMs: 60_000 });
    expect(put.request.headers.get('If-Match')).toBe('"3"');
    put.flush(view({ startMs: 500, cut: 'running', version: 4 }));
  });

  it("BR-10: a 412 shows the other person's and keeps the adjustment", async () => {
    const { root } = await conflicted();

    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Outra pessoa mudou esta faixa');
    expect(alert?.textContent).toContain('O título dela');
    expect(alert?.textContent).toContain('0:02,0');
    expect(root.querySelector('.times')?.textContent).toContain('0:00,5');
  });

  it('BR-10: while the conflict stands, nothing saves on the old version', async () => {
    const { button } = await conflicted();

    expect(button('Salvar limites').disabled).toBe(true);
  });

  it('BR-10: "Salvar o meu por cima" sends the adjustment on their version', async () => {
    const { click, fixture, root } = await conflicted();

    await click('Salvar o meu por cima');

    const put = http.expectOne({ method: 'PUT', url: BOUNDS_URL });
    expect(put.request.body).toEqual({ startMs: 500, endMs: 60_000 });
    expect(put.request.headers.get('If-Match')).toBe('"4"');
    put.flush(view({ startMs: 500, version: 5, cut: 'running' }));
    await fixture.whenStable();
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  it('BR-10: "Usar o da outra pessoa" drops the adjustment', async () => {
    const { click, root } = await conflicted();

    await click('Usar o da outra pessoa');

    expect(root.querySelector('.times')?.textContent).toContain('0:02,0');
    expect(root.querySelector('[role="alert"]')).toBeNull();
  });

  async function refusedByHerCut() {
    const page = await open();
    await page.click('+0,5 s');
    await page.click('Salvar limites');
    http
      .expectOne({ method: 'PUT', url: BOUNDS_URL })
      .flush(CUT_RUNNING, { status: 409, statusText: 'Conflict' });
    await page.fixture.whenStable();
    http
      .expectOne(VIEW_URL)
      .flush(view({ version: 4, startMs: 2_000, cut: 'running' }));
    await page.fixture.whenStable();
    return page;
  }

  it('BR-10: a 409 of her running cut shows her bounds and keeps the adjustment', async () => {
    const { root } = await refusedByHerCut();

    const alert = root.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Outra pessoa mudou esta faixa');
    expect(alert?.textContent).toContain('0:02,0');
    expect(root.querySelector('.times')?.textContent).toContain('0:00,5');
  });

  it('BR-10: while her cut runs, the adjustment cannot go over it', async () => {
    const { button, root } = await refusedByHerCut();

    expect(button('Salvar o meu por cima').disabled).toBe(true);
    expect(button('Salvar limites').disabled).toBe(true);
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'quando ele terminar',
    );
  });

  it('BR-10: when her cut lands, the person chooses, on her version', async () => {
    pollMs = 5;
    const { button, click, fixture } = await refusedByHerCut();

    await vi.waitFor(() => {
      TestBed.tick();
      const reads = http.match(VIEW_URL);
      expect(reads.length).toBeGreaterThan(0);
      reads.forEach((one) => one.flush(view({ version: 4, startMs: 2_000 })));
    });
    await fixture.whenStable();
    http
      .match(VIEW_URL)
      .forEach((late) => late.flush(view({ version: 4, startMs: 2_000 })));
    expect(button('Salvar o meu por cima').disabled).toBe(false);

    await click('Salvar o meu por cima');

    const put = http.expectOne({ method: 'PUT', url: BOUNDS_URL });
    expect(put.request.body).toEqual({ startMs: 500, endMs: 60_000 });
    expect(put.request.headers.get('If-Match')).toBe('"4"');
    put.flush(view({ startMs: 500, version: 5 }));
    await fixture.whenStable();
  });

  it('BR-10: a version read behind the screen does not become the one the save names', async () => {
    const { click, fixture } = await open();
    await click('+0,5 s');
    await click('Salvar limites');
    http
      .expectOne({ method: 'PUT', url: BOUNDS_URL })
      .flush(null, { status: 500, statusText: 'Failed' });
    TestBed.tick();
    http.expectOne(VIEW_URL).flush(view({ startMs: 2_000, version: 4 }));
    await fixture.whenStable();

    await click('Salvar limites');

    const put = http.expectOne({ method: 'PUT', url: BOUNDS_URL });
    expect(put.request.headers.get('If-Match')).toBe('"3"');
    put.flush(null, { status: 412, statusText: 'Precondition Failed' });
    await fixture.whenStable();
    http.expectOne(VIEW_URL).flush(view({ startMs: 2_000, version: 4 }));
    await fixture.whenStable();
  });

  it('a refused save keeps the adjustment too', async () => {
    const { click, fixture, root } = await open();
    await click('+0,5 s');
    await click('Salvar limites');

    http
      .expectOne({ method: 'PUT', url: BOUNDS_URL })
      .flush(null, { status: 409, statusText: 'Conflict' });
    TestBed.tick();
    http.expectOne(VIEW_URL).flush(view({ startMs: 2_000, version: 4 }));
    await fixture.whenStable();

    expect(root.querySelector('.times')?.textContent).toContain('0:00,5');
    expect(root.textContent).toContain('0:00,5');
  });

  it('FR-6: a failed cut says so and can be tried again', async () => {
    const { click, fixture, root } = await open(
      view({ cut: 'failed', startMs: 500 }),
    );
    expect(root.querySelector('[role="alert"]')?.textContent).toContain(
      'Não foi possível recortar.',
    );

    await click('Tentar de novo');

    const retry = http.expectOne({
      method: 'POST',
      url: `${BOUNDS_URL}/retry`,
    });
    expect(retry.request.headers.get('If-Match')).toBe('"3"');
    retry.flush(view({ cut: 'running', startMs: 500 }));
    await fixture.whenStable();
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(root.querySelector('[role="status"]')?.textContent).toContain(
      'Recortando…',
    );
  });
});
