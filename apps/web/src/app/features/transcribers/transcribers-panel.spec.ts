import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { Transcriber } from '@kb-chat/contracts';
import { TranscribersPanel } from './transcribers-panel.js';

const URL = '/api/v1/media/transcribers';

const aTranscriber = (overrides: Partial<Transcriber> = {}): Transcriber => ({
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  name: 'Mac do dono',
  kinds: ['transcribe'],
  createdAt: '2026-11-03T10:00:00.000Z',
  lastSeenAt: null,
  online: false,
  currentJob: null,
  ...overrides,
});

async function renderPanel(items: Transcriber[] = []) {
  const result = await render(TranscribersPanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(URL).flush({ items });
  await result.fixture.whenStable();
  return { ...result, http };
}

describe('TranscribersPanel (KBC-036 FR-5, BR-1)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('says none is paired and what that means', async () => {
    await renderPanel();
    expect(document.body.textContent).toContain(
      'Nenhum transcritor pareado. Sem um, os áudios ficam aguardando a transcrição.',
    );
  });

  it('lists each one on or off in words, when it was last seen and what it transcribes', async () => {
    await renderPanel([
      aTranscriber({
        online: true,
        lastSeenAt: new Date(2026, 10, 3, 14, 5).toISOString(),
        currentJob: {
          mediaId: '11111111-1111-4111-8111-111111111111',
          title: 'Palestra de 1998',
          kind: 'transcribe',
        },
      }),
      aTranscriber({
        id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        name: 'Mac velho',
      }),
    ]);
    const [first, second] = screen.getAllByRole('listitem');
    expect(first?.textContent).toContain('Ligado');
    expect(first?.textContent).toContain(
      'visto por último em 03/11/2026 às 14:05',
    );
    expect(first?.textContent).toContain('transcrevendo "Palestra de 1998"');
    expect(second?.textContent).toContain('Desligado');
    expect(second?.textContent).toContain('ainda não foi visto');
  });

  it('asks for a name before pairing (MA-23)', async () => {
    const { fixture } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Parear transcritor' }));
    await fixture.whenStable();
    expect(
      screen.getByLabelText(/Nome do transcritor/).getAttribute('aria-invalid'),
    ).toBe('true');
    expect(document.body.textContent).toContain('Dê um nome ao transcritor.');
  });

  it('pairs and shows the token once, with the command for the Mac', async () => {
    const { fixture, http } = await renderPanel();
    fireEvent.input(screen.getByLabelText(/Nome do transcritor/), {
      target: { value: '  Mac do dono ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Parear transcritor' }));
    const request = http.expectOne({ method: 'POST', url: URL });
    expect(request.request.body).toEqual({ name: 'Mac do dono' });
    request.flush({
      transcriber: aTranscriber(),
      token: 'nat_the-secret-token-of-the-mac-0123456789',
    });
    TestBed.tick();
    http.expectOne(URL).flush({ items: [aTranscriber()] });
    await fixture.whenStable();
    const box = screen.getByRole('region', { name: '"Mac do dono" pareado' });
    expect(box.textContent).toContain(
      'nat_the-secret-token-of-the-mac-0123456789',
    );
    expect(box.textContent).toContain(
      'uv run --project tools/transcriber transcriber pair --api-url http://localhost',
    );
    expect(box.textContent).toContain('aparece só esta vez');
    fireEvent.click(screen.getByRole('button', { name: 'Pronto, já copiei' }));
    await fixture.whenStable();
    expect(document.body.textContent).not.toContain('nat_the-secret-token');
  });

  it('lists the new one even when the first read was still on its way (E2E AC-10)', async () => {
    const result = await render(TranscribersPanel, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const first = http.expectOne(URL);
    fireEvent.input(screen.getByLabelText(/Nome do transcritor/), {
      target: { value: 'Mac novo' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Parear transcritor' }));
    http.expectOne({ method: 'POST', url: URL }).flush({
      transcriber: aTranscriber({ name: 'Mac novo' }),
      token: 'nat_the-secret-token-of-the-mac-0123456789',
    });
    TestBed.tick();
    // The read sent before the pairing would answer without it: it is dropped, and a
    // fresh one goes out.
    expect(first.cancelled).toBe(true);
    http
      .expectOne({ method: 'GET', url: URL })
      .flush({ items: [aTranscriber({ name: 'Mac novo' })] });
    await result.fixture.whenStable();
    expect(
      screen.getByRole('button', { name: 'Revogar Mac novo' }),
    ).toBeTruthy();
  });

  it('copies the token and says so', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    const { fixture, http } = await renderPanel();
    fireEvent.input(screen.getByLabelText(/Nome do transcritor/), {
      target: { value: 'Mac' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Parear transcritor' }));
    http.expectOne({ method: 'POST', url: URL }).flush({
      transcriber: aTranscriber(),
      token: 'nat_the-secret-token-of-the-mac-0123456789',
    });
    TestBed.tick();
    http.expectOne(URL).flush({ items: [aTranscriber()] });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Copiar token' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('button', { name: 'Copiado' })).toBeTruthy(),
    );
    // Said in the live region too: a button's new text is not always announced (UP-01).
    expect(screen.getByRole('status').textContent).toContain('Token copiado.');
    expect(writeText).toHaveBeenCalledWith(
      'nat_the-secret-token-of-the-mac-0123456789',
    );
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copiar comando' }));
    await vi.waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Não deu para copiar' }),
      ).toBeTruthy(),
    );
  });

  it('says when pairing failed', async () => {
    const { fixture, http } = await renderPanel();
    fireEvent.input(screen.getByLabelText(/Nome do transcritor/), {
      target: { value: 'Mac' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Parear transcritor' }));
    http
      .expectOne({ method: 'POST', url: URL })
      .flush({}, { status: 500, statusText: 'Error' });
    TestBed.tick();
    http.expectOne(URL).flush({ items: [] });
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Não consegui parear. Tente de novo.',
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Parear transcritor' }),
    );
  });

  it('revokes only after the confirmation (UP-07)', async () => {
    const { fixture, http } = await renderPanel([aTranscriber()]);
    fireEvent.click(
      screen.getByRole('button', { name: 'Revogar Mac do dono' }),
    );
    await fixture.whenStable();
    expect(document.body.textContent).toContain('Revogar "Mac do dono"?');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: 'Revogar Mac do dono' }),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    http
      .expectOne({ method: 'DELETE', url: `${URL}/${aTranscriber().id}` })
      .flush(null, { status: 204, statusText: 'No Content' });
    TestBed.tick();
    http.expectOne(URL).flush({ items: [] });
    await fixture.whenStable();
    expect(document.body.textContent).toContain('Nenhum transcritor pareado.');
  });

  it('says when revoking failed', async () => {
    const { fixture, http } = await renderPanel([aTranscriber()]);
    fireEvent.click(
      screen.getByRole('button', { name: 'Revogar Mac do dono' }),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    http
      .expectOne({ method: 'DELETE', url: `${URL}/${aTranscriber().id}` })
      .flush({}, { status: 500, statusText: 'Error' });
    TestBed.tick();
    http.expectOne(URL).flush({ items: [aTranscriber()] });
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Não consegui revogar. Tente de novo.',
    );
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Revogar' }),
    );
  });

  it('offers to try again when the list did not load', async () => {
    const result = await render(TranscribersPanel, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(URL).flush({}, { status: 500, statusText: 'Error' });
    await result.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar os transcritores.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    TestBed.tick();
    http.expectOne(URL).flush({ items: [] });
    await result.fixture.whenStable();
    expect(document.body.textContent).toContain('Nenhum transcritor pareado.');
  });

  it('moves the focus where it is useful when what held it goes away (WCAG 2.4.3)', async () => {
    const { fixture, http } = await renderPanel([aTranscriber()]);
    const revoke = () =>
      screen.getByRole('button', { name: 'Revogar Mac do dono' });
    fireEvent.click(revoke());
    await fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Cancelar' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(document.activeElement).toBe(revoke());
    fireEvent.click(revoke());
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar' }));
    http
      .expectOne({ method: 'DELETE', url: `${URL}/${aTranscriber().id}` })
      .flush(null, { status: 204, statusText: 'No Content' });
    TestBed.tick();
    http.expectOne(URL).flush({ items: [] });
    await fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { name: 'Pareados' }),
    );
    expect(screen.getByRole('status').textContent).toContain(
      '"Mac do dono" revogado.',
    );
  });

  it('gives the focus back to the name field after "Pronto, já copiei"', async () => {
    const { fixture, http } = await renderPanel();
    fireEvent.input(screen.getByLabelText(/Nome do transcritor/), {
      target: { value: 'Mac' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Parear transcritor' }));
    http.expectOne({ method: 'POST', url: URL }).flush({
      transcriber: aTranscriber(),
      token: 'nat_the-secret-token-of-the-mac-0123456789',
    });
    TestBed.tick();
    http.expectOne(URL).flush({ items: [aTranscriber()] });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Pronto, já copiei' }));
    await fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByLabelText(/Nome do transcritor/),
    );
  });

  it('says at the field that the name is taken (MA-23)', async () => {
    const { fixture, http } = await renderPanel([aTranscriber()]);
    fireEvent.input(screen.getByLabelText(/Nome do transcritor/), {
      target: { value: 'Mac do dono' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Parear transcritor' }));
    http
      .expectOne({ method: 'POST', url: URL })
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'taken' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    const field = screen.getByLabelText(/Nome do transcritor/);
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain(
      'Já existe um transcritor com esse nome. Escolha outro.',
    );
    expect(document.activeElement).toBe(field);
  });

  it('marks a transcriber to separate voices and says so (KBC-064 FR-6)', async () => {
    const { fixture, http } = await renderPanel([aTranscriber()]);
    const box = screen.getByRole('checkbox', {
      name: 'Separa vozes: Mac do dono',
    });
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);
    const patch = http.expectOne({
      method: 'PATCH',
      url: `${URL}/${aTranscriber().id}`,
    });
    expect(patch.request.body).toEqual({ kinds: ['transcribe', 'diarize'] });
    patch.flush(aTranscriber({ kinds: ['transcribe', 'diarize'] }));
    TestBed.tick();
    http.expectOne(URL).flush({
      items: [aTranscriber({ kinds: ['transcribe', 'diarize'] })],
    });
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      '"Mac do dono" agora separa vozes.',
    );
    expect(
      (
        screen.getByRole('checkbox', {
          name: 'Separa vozes: Mac do dono',
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });

  it('says what a transcriber is doing: separating voices or transcribing', async () => {
    await renderPanel([
      aTranscriber({
        kinds: ['transcribe', 'diarize'],
        currentJob: {
          mediaId: '11111111-1111-4111-8111-111111111111',
          title: 'Entrevista',
          kind: 'diarize',
        },
      }),
    ]);
    expect(screen.getByRole('listitem').textContent).toContain(
      'separando as vozes de "Entrevista"',
    );
  });

  describe('voice profiles (KBC-071, ADR 0032)', () => {
    it('starts unmarked, and marking it keeps what the transcriber already does', async () => {
      const { http, fixture } = await renderPanel([
        aTranscriber({ kinds: ['transcribe', 'diarize'] }),
      ]);
      const box = screen.getByRole<HTMLInputElement>('checkbox', {
        name: 'Perfis de voz: Mac do dono',
      });
      expect(box.checked).toBe(false);
      fireEvent.click(box);
      const patch = http.expectOne(
        `${URL}/dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
      );
      expect(patch.request.body).toEqual({
        kinds: ['transcribe', 'diarize', 'voice-profile'],
      });
      patch.flush(aTranscriber());
      TestBed.tick();
      http.expectOne(URL).flush({ items: [aTranscriber()] });
      await fixture.whenStable();
    });

    it('KBC-099: "Publica no acervo" starts unmarked and marks the kb-publish kind', async () => {
      const { http, fixture } = await renderPanel([
        aTranscriber({ kinds: ['transcribe', 'diarize'] }),
      ]);
      const box = screen.getByRole<HTMLInputElement>('checkbox', {
        name: 'Publica no acervo: Mac do dono',
      });
      expect(box.checked).toBe(false);
      fireEvent.click(box);
      const patch = http.expectOne(
        `${URL}/dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
      );
      expect(patch.request.body).toEqual({
        kinds: ['transcribe', 'diarize', 'kb-publish'],
      });
      patch.flush(aTranscriber());
      TestBed.tick();
      http.expectOne(URL).flush({ items: [aTranscriber()] });
      await fixture.whenStable();
      expect(
        await screen.findByText(
          '"Mac do dono" agora publica as faixas no acervo.',
        ),
      ).toBeTruthy();
    });

    it('unmarking "Separa vozes" keeps the voice profiles mark', async () => {
      const { http, fixture } = await renderPanel([
        aTranscriber({ kinds: ['transcribe', 'diarize', 'voice-profile'] }),
      ]);
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Separa vozes: Mac do dono' }),
      );
      const patch = http.expectOne(
        `${URL}/dddddddd-dddd-4ddd-8ddd-dddddddddddd`,
      );
      expect(patch.request.body).toEqual({
        kinds: ['transcribe', 'voice-profile'],
      });
      patch.flush(aTranscriber());
      TestBed.tick();
      http.expectOne(URL).flush({ items: [aTranscriber()] });
      await fixture.whenStable();
    });
  });
});
