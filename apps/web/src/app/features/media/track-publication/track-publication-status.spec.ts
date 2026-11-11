import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { TrackPublication } from '@kb-chat/contracts';
import { TrackPublicationStatus } from './track-publication-status.js';

const ID = '0b9c1f7e-1111-4a2b-8c3d-000000000001';
const URL = `/api/v1/media/${ID}/publication`;
const RETRY = `${URL}/retry`;

/** 14:02 where the test runs, today: what the page shows as "desde 14:02". */
const at1402 = (): string => {
  const date = new Date();
  date.setHours(14, 2, 0, 0);
  return date.toISOString();
};

async function renderIt(publication: TrackPublication | null) {
  const result = await render(TrackPublicationStatus, {
    inputs: { mediaId: ID },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(URL).flush({ mediaId: ID, publication });
  await result.fixture.whenStable();
  return { ...result, http };
}

const status = () => screen.getByRole('status');

describe('TrackPublicationStatus (KBC-100 FR-3, BR-4, T22)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('AC-15: "Na pesquisa" is said in words, with since when, in a status region', async () => {
    await renderIt({ state: 'live', since: at1402() });
    expect(status().textContent).toContain('Pesquisa com IA:');
    expect(status().textContent).toContain('Na pesquisa');
    expect(status().textContent).toContain('desde 14:02');
  });

  it('AC-7: with the Mac off it says since when it is off', async () => {
    await renderIt({ state: 'waiting-mac', offSince: at1402() });
    expect(status().textContent).toContain(
      'Aguardando o Mac do dono (desligado desde 14:02)',
    );
  });

  it('a Mac never paired is waited for without a time', async () => {
    await renderIt({ state: 'waiting-mac', offSince: null });
    expect(status().textContent?.replace(/\s+/g, ' ')).toContain(
      'Aguardando o Mac do dono',
    );
    expect(status().textContent).not.toContain('desligado desde');
  });

  it('BR-4: updating says so, with since when', async () => {
    await renderIt({ state: 'updating', since: at1402() });
    expect(status().textContent).toContain('Atualizando na pesquisa');
    expect(status().textContent).toContain('desde 14:02');
  });

  it.each([
    ['no-folder', 'Fora da pesquisa: o acervo ainda não tem pasta no kb'],
    ['cap', 'Fora da pesquisa: teto mensal da mídia'],
    ['not-published', 'Fora da pesquisa: ainda não publicada no acervo'],
  ] as const)('AC-11/AC-12: out because of %s', async (reason, text) => {
    await renderIt({ state: 'out', reason });
    expect(status().textContent).toContain(text);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('AC-10: "Falhou" names the reason, and "Tentar de novo" queues it again and says so', async () => {
    const { fixture, http } = await renderIt({
      state: 'failed',
      since: at1402(),
      reason: 'kb classify: OpenRouter 502',
    });
    expect(status().textContent).toContain(
      'Falhou: kb classify: OpenRouter 502',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    // PD-02: a second click before the answer sends nothing more.
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    const retry = http.expectOne(RETRY);
    expect(retry.request.method).toBe('POST');
    retry.flush({
      mediaId: ID,
      publication: { state: 'updating', since: at1402() },
    });
    await fixture.whenStable();
    expect(status().textContent).toContain('Atualizando na pesquisa');
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    // The button went: the focus goes to the line that says what happened (WCAG 2.4.3).
    expect(document.activeElement).toBe(status());
  });

  it('a retry that fails says so and keeps the button', async () => {
    const { fixture, http } = await renderIt({
      state: 'failed',
      since: at1402(),
      reason: 'kb link: exit 1',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    http.expectOne(RETRY).flush({}, { status: 500, statusText: 'x' });
    await fixture.whenStable();
    expect(status().textContent).toContain('Não foi possível tentar de novo.');
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
  });

  it('a media with no document shows nothing', async () => {
    const { container } = await renderIt(null);
    expect(container.textContent?.trim()).toBe('');
  });

  it('while it waits, it is read again every 30 s; once live, not', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      const { fixture, http } = await renderIt({
        state: 'updating',
        since: at1402(),
      });
      vi.advanceTimersByTime(29_999);
      TestBed.tick();
      http.expectNone(URL);
      vi.advanceTimersByTime(1);
      TestBed.tick();
      http.expectOne(URL).flush({
        mediaId: ID,
        publication: { state: 'live', since: at1402() },
      });
      await fixture.whenStable();
      expect(status().textContent).toContain('Na pesquisa');
      vi.advanceTimersByTime(120_000);
      TestBed.tick();
      http.expectNone(URL);
    } finally {
      vi.useRealTimers();
    }
  });
});
