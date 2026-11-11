import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type {
  Diarization,
  MediaSpeakers,
  VoiceLabel,
} from '@kb-chat/contracts';
import { MediaEngine } from '@core/media/media-engine.js';
import { SAMPLE_ELEMENT_FACTORY } from './voice-sample.js';
import { VoicesPanel } from './voices-panel.js';

const MEDIA_ID = '11111111-1111-4111-8111-111111111111';
const URL = `/api/v1/media/${MEDIA_ID}/speakers`;
const DIARIZE = `/api/v1/media/${MEDIA_ID}/diarize`;
const VOICES = `/api/v1/media/${MEDIA_ID}/voices`;
const TOPIC_SPEAKERS = '/api/v1/topics/udv/speakers';
const TOPIC_AUTHORS = '/api/v1/topics/udv/authors';
const ANA = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Ana',
  authorSlug: null,
  main: false,
};
const MASTER = { slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: true };

const unnamed = (voice: number): VoiceLabel => ({
  voice,
  kind: 'unnamed',
  speakerId: null,
  name: null,
  main: false,
});

const aDiarization = (overrides: Partial<Diarization> = {}): Diarization => ({
  version: 1,
  createdAt: '2026-11-03T12:00:00.000Z',
  transcriptVersion: 1,
  staleTranscript: false,
  requestedVoices: null,
  voiceCount: 3,
  voices: [
    { voice: 1, speakingMs: 12_100 },
    { voice: 2, speakingMs: 642_900 },
    { voice: 3, speakingMs: 5_000 },
  ],
  turns: [
    { voice: 1, startMs: 0, endMs: 12_100 },
    { voice: 2, startMs: 12_100, endMs: 655_000 },
    { voice: 3, startMs: 655_000, endMs: 660_000 },
  ],
  segments: [],
  labels: [unnamed(1), unnamed(2), unnamed(3)],
  merged: [],
  namesPending: false,
  ...overrides,
});

const speakers = (overrides: Partial<MediaSpeakers> = {}): MediaSpeakers => ({
  mediaId: MEDIA_ID,
  status: 'none',
  transcriber: 'on',
  transcriberOffSince: null,
  canRequest: true,
  diarization: null,
  voiceSuggestions: [],
  ...overrides,
});

const ENGINE = { playing: () => false, pause: vi.fn(), play: vi.fn() };
const renames = { count: 0 };
const fakeSample = () => {
  const element = document.createElement('audio');
  element.play = () => Promise.resolve();
  element.pause = () => undefined;
  return element;
};

async function renderPanel(
  first: MediaSpeakers,
  { lists = true }: { lists?: boolean } = {},
) {
  renames.count = 0;
  const result = await render(VoicesPanel, {
    inputs: { mediaId: MEDIA_ID, topic: 'udv' },
    on: { renamed: () => (renames.count += 1) },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MediaEngine, useValue: ENGINE },
      { provide: SAMPLE_ELEMENT_FACTORY, useValue: fakeSample },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(URL).flush(first);
  if (first.diarization) {
    await settle();
    if (!lists) return { ...result, http };
    flushLists(http);
  }
  await result.fixture.whenStable();
  return { ...result, http };
}

/** Lets a resource take a flushed answer and ask what depends on it. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

const flushLists = (http: HttpTestingController) => {
  http.expectOne(TOPIC_SPEAKERS).flush({ items: [ANA] });
  http.expectOne(TOPIC_AUTHORS).flush({ items: [MASTER] });
};

const voiceItems = () =>
  within(screen.getByRole('list', { name: 'Vozes encontradas' })).getAllByRole(
    'listitem',
  );

const status = () => screen.getByRole('status').textContent?.trim();

describe('VoicesPanel (KBC-064 FR-1, FR-4)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('offers "Separar vozes" with an optional number and says nothing of a voice print', async () => {
    await renderPanel(speakers());
    expect(screen.getByRole('heading', { name: 'Vozes' })).toBeTruthy();
    expect(document.body.textContent).toContain(
      'nenhuma impressão de voz é guardada',
    );
    expect(screen.getByLabelText('Número de vozes (opcional)')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Separar vozes' })).toBeTruthy();
  });

  it('asks for a separation with the number given and shows it waiting (AC-1, AC-6)', async () => {
    const { fixture, http } = await renderPanel(speakers());
    fireEvent.input(screen.getByLabelText('Número de vozes (opcional)'), {
      target: { value: ' 2 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Separar vozes' }));
    const asked = http.expectOne({ method: 'POST', url: DIARIZE });
    expect(asked.request.body).toEqual({ voices: 2 });
    asked.flush(speakers({ status: 'waiting', canRequest: false }));
    await fixture.whenStable();
    expect(status()).toBe('Aguardando o transcritor');
    expect(screen.queryByRole('button', { name: /Separar vozes/ })).toBeNull();
  });

  it('sends no number when the field is blank', async () => {
    const { fixture, http } = await renderPanel(speakers());
    fireEvent.click(screen.getByRole('button', { name: 'Separar vozes' }));
    const asked = http.expectOne({ method: 'POST', url: DIARIZE });
    expect(asked.request.body).toEqual({ voices: null });
    asked.flush(speakers({ status: 'waiting', canRequest: false }));
    await fixture.whenStable();
  });

  it('refuses a number out of 1 to 10 at the field (MA-23)', async () => {
    const { fixture } = await renderPanel(speakers());
    const field = screen.getByLabelText('Número de vozes (opcional)');
    fireEvent.input(field, { target: { value: '12' } });
    fireEvent.click(screen.getByRole('button', { name: 'Separar vozes' }));
    await fixture.whenStable();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain(
      'Informe um número de 1 a 10, ou deixe em branco.',
    );
  });

  it('says when no transcriber separates voices (AC-9)', async () => {
    await renderPanel(
      speakers({ status: 'waiting', transcriber: 'none', canRequest: false }),
    );
    expect(status()).toBe(
      'Nenhum transcritor separa vozes; marque em Transcritores',
    );
  });

  it('says since when the transcriber is off', async () => {
    await renderPanel(
      speakers({
        status: 'waiting',
        transcriber: 'off',
        transcriberOffSince: new Date(2026, 10, 3, 9, 30).toISOString(),
        canRequest: false,
      }),
    );
    expect(status()).toBe(
      'Aguardando o transcritor · desligado desde 03/11/2026 às 09:30',
    );
  });

  it('follows the job in words while it runs', async () => {
    await renderPanel(speakers({ status: 'diarizing', canRequest: false }));
    expect(status()).toBe('Separando vozes…');
  });

  it('lists the voices found with how long each speaks, each as "Voz N" text (AC-1, AC-8)', async () => {
    await renderPanel(
      speakers({ status: 'done', diarization: aDiarization() }),
    );
    expect(status()).toBe('Vozes separadas: 3');
    const voices = voiceItems()
      .map((item) => item.querySelector('.voice-head')?.textContent)
      .map((text) => text?.replace(/\s+/g, ' ').trim());
    expect(voices).toEqual([
      'Voz 1 0:12 de falaOuvir amostra da Voz 1',
      'Voz 2 10:42 de falaOuvir amostra da Voz 2',
      'Voz 3 0:05 de falaOuvir amostra da Voz 3',
    ]);
    expect(
      screen.getByRole('button', { name: 'Separar vozes de novo' }),
    ).toBeTruthy();
  });

  it('says one voice for a recording of one voice (AC-5)', async () => {
    await renderPanel(
      speakers({
        status: 'done',
        diarization: aDiarization({
          voiceCount: 1,
          voices: [{ voice: 1, speakingMs: 60_000 }],
        }),
      }),
    );
    expect(status()).toBe('Vozes separadas: 1');
    expect(voiceItems()).toHaveLength(1);
  });

  it('warns that the voices were made on an older transcript and offers to redo (AC-4)', async () => {
    await renderPanel(
      speakers({
        status: 'done',
        diarization: aDiarization({
          staleTranscript: true,
          transcriptVersion: 2,
        }),
      }),
    );
    expect(document.body.textContent).toContain(
      'Feita sobre uma transcrição anterior.',
    );
    expect(
      screen.getByRole('button', { name: 'Separar vozes de novo' }),
    ).toBeTruthy();
  });

  it('says a failure in words and still lets the person ask again', async () => {
    await renderPanel(speakers({ status: 'failed' }));
    expect(status()).toBe('A separação de vozes falhou');
    expect(screen.getByRole('button', { name: 'Separar vozes' })).toBeTruthy();
  });

  it('says a new run failed and still shows the earlier voices (QA BUG-2)', async () => {
    await renderPanel(
      speakers({ status: 'failed', diarization: aDiarization() }),
    );
    expect(status()).toBe('A separação de vozes falhou');
    expect(voiceItems()).toHaveLength(3);
    expect(
      screen.getByRole('button', { name: 'Separar vozes de novo' }),
    ).toBeTruthy();
  });

  it('explains why there is no button before the transcript', async () => {
    await renderPanel(speakers({ canRequest: false }));
    expect(document.body.textContent).toContain(
      'Dá para separar as vozes quando a transcrição estiver pronta.',
    );
  });

  it('reloads when someone else asked meanwhile (409), and offers a retry on other errors', async () => {
    const { fixture, http } = await renderPanel(speakers());
    fireEvent.click(screen.getByRole('button', { name: 'Separar vozes' }));
    http
      .expectOne({ method: 'POST', url: DIARIZE })
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'busy' } },
        { status: 409, statusText: 'Conflict' },
      );
    TestBed.tick();
    http
      .expectOne(URL)
      .flush(speakers({ status: 'waiting', canRequest: false }));
    await fixture.whenStable();
    expect(status()).toBe('Aguardando o transcritor');
  });

  it('shows a load failure with a retry', async () => {
    const result = await render(VoicesPanel, {
      inputs: { mediaId: MEDIA_ID },
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(URL).flush(null, { status: 500, statusText: 'Error' });
    await result.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar as vozes.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    TestBed.tick();
    http.expectOne(URL).flush(speakers());
    await result.fixture.whenStable();
    expect(screen.getByRole('button', { name: 'Separar vozes' })).toBeTruthy();
  });
});

describe('VoicesPanel: naming the voices (KBC-065)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  const done = (overrides: Partial<Diarization> = {}) =>
    speakers({ status: 'done', diarization: aDiarization(overrides) });
  const field = (voice: number) =>
    screen.getByRole<HTMLInputElement>('combobox', {
      name: `Quem é a Voz ${voice}?`,
    });

  const openSpeakers = () => {
    const summary = screen.getByText('Falantes do acervo (1)');
    summary.closest('details')?.setAttribute('open', '');
  };

  async function choose(
    fixture: { whenStable(): Promise<unknown> },
    voice: number,
    option: string | RegExp,
  ) {
    fireEvent.click(field(voice));
    await fixture.whenStable();
    fireEvent.mouseDown(
      within(
        field(voice).closest('app-speaker-combobox') as HTMLElement,
      ).getByRole('option', { name: option }),
    );
  }

  it('AC-2: offers the speakers and authors of the collection, and names a voice', async () => {
    const { fixture, http } = await renderPanel(done());
    fireEvent.click(field(1));
    await fixture.whenStable();
    const list = within(
      field(1).closest('app-speaker-combobox') as HTMLElement,
    );
    expect(
      list.getAllByRole('option').map((one) => one.textContent?.trim()),
    ).toEqual([
      'Pergunta da plateia',
      expect.stringContaining('Mestre Gabriel'),
      'Ana',
    ]);
    fireEvent.mouseDown(list.getByRole('option', { name: 'Ana' }));
    const put = http.expectOne({ method: 'PUT', url: `${VOICES}/1` });
    expect(put.request.body).toEqual({
      version: 1,
      speakerId: ANA.id,
      audience: false,
    });
    put.flush(
      done({
        labels: [
          { ...unnamed(1), kind: 'person', speakerId: ANA.id, name: 'Ana' },
          unnamed(2),
          unnamed(3),
        ],
      }),
    );
    await fixture.whenStable();
    expect(field(1).value).toBe('Ana');
    expect(document.body.textContent).toContain('Nome salvo.');
    expect(renames.count).toBe(1);
  });

  it('BUG-6: says the list is on its way, and stops when it arrives', async () => {
    const { fixture, http } = await renderPanel(done(), { lists: false });
    fireEvent.click(field(1));
    await settle();
    const list = within(
      field(1).closest('app-speaker-combobox') as HTMLElement,
    );
    expect(list.getByRole('option', { name: 'Carregando…' })).toBeTruthy();
    flushLists(http);
    await fixture.whenStable();
    expect(list.queryByRole('option', { name: 'Carregando…' })).toBeNull();
    expect(list.getByRole('option', { name: 'Ana' })).toBeTruthy();
  });

  it('does not hold the field on "Carregando…" when a list fails', async () => {
    const { fixture, http } = await renderPanel(done(), { lists: false });
    http
      .expectOne(TOPIC_SPEAKERS)
      .flush(null, { status: 500, statusText: 'Server Error' });
    http.expectOne(TOPIC_AUTHORS).flush({ items: [] });
    await fixture.whenStable();
    fireEvent.click(field(1));
    await fixture.whenStable();
    expect(screen.queryByRole('option', { name: 'Carregando…' })).toBeNull();
  });

  it('AC-1: marks a voice as the audience', async () => {
    const { fixture, http } = await renderPanel(done());
    await choose(fixture, 2, 'Pergunta da plateia');
    const put = http.expectOne({ method: 'PUT', url: `${VOICES}/2` });
    expect(put.request.body).toEqual({
      version: 1,
      speakerId: null,
      audience: true,
    });
    put.flush(
      done({
        labels: [unnamed(1), { ...unnamed(2), kind: 'audience' }, unnamed(3)],
      }),
    );
    await fixture.whenStable();
    expect(field(2).value).toBe('Pergunta da plateia');
  });

  it('turns an author into a speaker first, then names the voice', async () => {
    const { fixture, http } = await renderPanel(done());
    await choose(fixture, 1, /Mestre Gabriel/);
    const created = http.expectOne({ method: 'POST', url: TOPIC_SPEAKERS });
    expect(created.request.body).toEqual({
      name: 'Mestre Gabriel',
      authorSlug: 'mestre-gabriel',
    });
    created.flush({ ...ANA, name: 'Mestre Gabriel', main: true });
    http.expectOne({ method: 'PUT', url: `${VOICES}/1` }).flush(done());
    await settle();
    http.expectOne(TOPIC_SPEAKERS).flush({ items: [ANA] });
    await fixture.whenStable();
  });

  it('registers a new name typed in the field', async () => {
    const { fixture, http } = await renderPanel(done());
    fireEvent.input(field(3), { target: { value: 'Maria' } });
    fireEvent.keyDown(field(3), { key: 'Enter' });
    const created = http.expectOne({ method: 'POST', url: TOPIC_SPEAKERS });
    expect(created.request.body).toEqual({ name: 'Maria' });
    created.flush({ ...ANA, name: 'Maria' });
    http.expectOne({ method: 'PUT', url: `${VOICES}/3` }).flush(done());
    await settle();
    http.expectOne(TOPIC_SPEAKERS).flush({ items: [ANA] });
    await fixture.whenStable();
  });

  it('reads the voices again and says so when they changed (409)', async () => {
    const { fixture, http } = await renderPanel(done());
    await choose(fixture, 1, 'Ana');
    http
      .expectOne({ method: 'PUT', url: `${VOICES}/1` })
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'old' } },
        { status: 409, statusText: 'Conflict' },
      );
    TestBed.tick();
    http.expectOne(URL).flush(done());
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'As vozes mudaram.',
    );
    expect(field(1).closest('li')?.textContent).toContain('As vozes mudaram.');
  });

  it('keeps a voice field usable while saving and sends changes in order', async () => {
    const { fixture, http } = await renderPanel(done());
    await choose(fixture, 1, 'Ana');
    expect(field(2).disabled).toBe(false);
    await choose(fixture, 2, 'Pergunta da plateia');
    http.expectNone({ method: 'PUT', url: `${VOICES}/2` });
    http.expectOne({ method: 'PUT', url: `${VOICES}/1` }).flush(done());
    http.expectOne({ method: 'PUT', url: `${VOICES}/2` }).flush(done());
    await fixture.whenStable();
    expect(renames.count).toBe(2);
  });

  it('gives the focus to the note when the button pressed goes away', async () => {
    const { fixture, http } = await renderPanel(done({ namesPending: true }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar nomes' }));
    http.expectOne({ method: 'POST', url: `${VOICES}/confirm` }).flush(done());
    await fixture.whenStable();
    expect(document.activeElement?.textContent?.trim()).toBe(
      'Nomes confirmados.',
    );
  });

  it('says a failure to save', async () => {
    const { fixture, http } = await renderPanel(done());
    await choose(fixture, 1, 'Ana');
    http
      .expectOne({ method: 'PUT', url: `${VOICES}/1` })
      .flush(null, { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui salvar.',
    );
    expect(field(1).closest('li')?.textContent).toContain(
      'Não consegui salvar.',
    );
    expect(field(2).closest('li')?.textContent).not.toContain(
      'Não consegui salvar.',
    );
  });

  it('AC-3: joins two voices and offers to undo it', async () => {
    const { fixture, http } = await renderPanel(done());
    const from = screen.getByLabelText('Juntar a voz');
    fireEvent.change(from, { target: { value: '3' } });
    await fixture.whenStable();
    const into = screen.getByLabelText('com a voz');
    expect(within(into).queryByRole('option', { name: 'Voz 3' })).toBeNull();
    fireEvent.change(into, { target: { value: '2' } });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Juntar' }));
    const merged = http.expectOne({ method: 'POST', url: `${VOICES}/merge` });
    expect(merged.request.body).toEqual({ version: 1, voice: 3, into: 2 });
    merged.flush(
      done({
        voiceCount: 2,
        voices: [
          { voice: 1, speakingMs: 12_100 },
          { voice: 2, speakingMs: 647_900 },
        ],
        merged: [{ voice: 3, into: 2 }],
      }),
    );
    await fixture.whenStable();
    expect(document.body.textContent).toContain('Voz 3 junta à Voz 2');
    fireEvent.click(screen.getByRole('button', { name: 'Separar a Voz 3' }));
    const split = http.expectOne({ method: 'POST', url: `${VOICES}/split` });
    expect(split.request.body).toEqual({ version: 1, voice: 3 });
    split.flush(done());
    await fixture.whenStable();
    expect(document.body.textContent).not.toContain('Voz 3 junta à Voz 2');
  });

  it('asks for both voices before joining', async () => {
    const { fixture, http } = await renderPanel(done());
    fireEvent.click(screen.getByRole('button', { name: 'Juntar' }));
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Escolha as duas vozes.',
    );
    http.expectNone(`${VOICES}/merge`);
  });

  it('has nothing to join with one voice', async () => {
    await renderPanel(
      done({
        voiceCount: 1,
        voices: [{ voice: 1, speakingMs: 60_000 }],
        labels: [unnamed(1)],
      }),
    );
    expect(screen.queryByRole('button', { name: 'Juntar' })).toBeNull();
  });

  it('AC-6: asks to confirm the names of a new separation until someone does', async () => {
    const { fixture, http } = await renderPanel(done({ namesPending: true }));
    expect(document.body.textContent).toContain('Confirme os nomes das vozes');
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar nomes' }));
    const confirmed = http.expectOne({
      method: 'POST',
      url: `${VOICES}/confirm`,
    });
    expect(confirmed.request.body).toEqual({ version: 1 });
    confirmed.flush(done());
    await fixture.whenStable();
    expect(document.body.textContent).not.toContain(
      'Confirme os nomes das vozes',
    );
  });

  it('AC-8: each voice has its sample button, whose name follows the state', async () => {
    const { fixture } = await renderPanel(done());
    fireEvent.click(
      screen.getByRole('button', { name: 'Ouvir amostra da Voz 2' }),
    );
    await fixture.whenStable();
    expect(
      screen.getByRole('button', { name: 'Parar amostra da Voz 2' }),
    ).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Parar amostra da Voz 2' }),
    );
    await fixture.whenStable();
    expect(
      screen.getByRole('button', { name: 'Ouvir amostra da Voz 2' }),
    ).toBeTruthy();
  });

  it('renames a speaker of the collection and reads the names again', async () => {
    const { fixture, http } = await renderPanel(done());
    openSpeakers();
    fireEvent.click(screen.getByRole('button', { name: /^Editar\s+Ana$/ }));
    await fixture.whenStable();
    const name = screen.getByLabelText('Nome');
    fireEvent.input(name, { target: { value: 'Ana Maria' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    const patched = http.expectOne({
      method: 'PATCH',
      url: `${TOPIC_SPEAKERS}/${ANA.id}`,
    });
    expect(patched.request.body).toEqual({
      name: 'Ana Maria',
      authorSlug: null,
    });
    patched.flush({ ...ANA, name: 'Ana Maria' });
    TestBed.tick();
    http.expectOne(TOPIC_SPEAKERS).flush({ items: [ANA] });
    http.expectOne(URL).flush(done());
    await fixture.whenStable();
    expect(renames.count).toBe(1);
  });

  describe('a speaker linked to an author (BUG-7, BR-2)', () => {
    const linked = { ...ANA, name: 'Mestre Gabriel', authorSlug: MASTER.slug };

    async function editLinked() {
      const result = await renderPanel(done(), { lists: false });
      result.http.expectOne(TOPIC_SPEAKERS).flush({ items: [linked] });
      result.http.expectOne(TOPIC_AUTHORS).flush({ items: [MASTER] });
      await result.fixture.whenStable();
      screen
        .getByText('Falantes do acervo (1)')
        .closest('details')
        ?.setAttribute('open', '');
      fireEvent.click(
        screen.getByRole('button', { name: /^Editar\s+Mestre Gabriel$/ }),
      );
      await result.fixture.whenStable();
      return result;
    }

    it("shows the author's name, not to be typed over, and says why", async () => {
      await editLinked();
      const name = screen.getByLabelText<HTMLInputElement>('Nome');
      expect(name.value).toBe('Mestre Gabriel');
      expect(name.readOnly).toBe(true);
      expect(name.getAttribute('aria-describedby')).toBeTruthy();
      expect(document.body.textContent).toContain('O nome vem do autor.');
    });

    it('lets the name be typed once it is no author', async () => {
      const { fixture, http } = await editLinked();
      fireEvent.change(screen.getByLabelText('Autor do acervo'), {
        target: { value: '' },
      });
      await fixture.whenStable();
      const name = screen.getByLabelText<HTMLInputElement>('Nome');
      expect(name.readOnly).toBe(false);
      fireEvent.input(name, { target: { value: 'Gabriel' } });
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
      const patched = http.expectOne({
        method: 'PATCH',
        url: `${TOPIC_SPEAKERS}/${ANA.id}`,
      });
      expect(patched.request.body).toEqual({
        name: 'Gabriel',
        authorSlug: null,
      });
      patched.flush(ANA);
      TestBed.tick();
      http.expectOne(TOPIC_SPEAKERS).flush({ items: [ANA] });
      http.expectOne(URL).flush(done());
      await fixture.whenStable();
    });

    it('takes the name of an author chosen in the form', async () => {
      const { fixture, http } = await renderPanel(done());
      openSpeakers();
      fireEvent.click(screen.getByRole('button', { name: /^Editar\s+Ana$/ }));
      await fixture.whenStable();
      fireEvent.change(screen.getByLabelText('Autor do acervo'), {
        target: { value: MASTER.slug },
      });
      await fixture.whenStable();
      expect(screen.getByLabelText<HTMLInputElement>('Nome').value).toBe(
        MASTER.name,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
      const patched = http.expectOne({
        method: 'PATCH',
        url: `${TOPIC_SPEAKERS}/${ANA.id}`,
      });
      expect(patched.request.body).toEqual({
        name: MASTER.name,
        authorSlug: MASTER.slug,
      });
      patched.flush({ ...ANA, name: MASTER.name, authorSlug: MASTER.slug });
      TestBed.tick();
      http.expectOne(TOPIC_SPEAKERS).flush({ items: [ANA] });
      http.expectOne(URL).flush(done());
      await fixture.whenStable();
    });
  });

  it('says a speaker name is taken or invalid at the form', async () => {
    const { fixture, http } = await renderPanel(done());
    openSpeakers();
    fireEvent.click(screen.getByRole('button', { name: /^Editar\s+Ana$/ }));
    await fixture.whenStable();
    fireEvent.input(screen.getByLabelText('Nome'), {
      target: { value: 'a'.repeat(121) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'de 1 a 120 caracteres',
    );
    fireEvent.input(screen.getByLabelText('Nome'), {
      target: { value: 'Bia' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    http
      .expectOne({ method: 'PATCH', url: `${TOPIC_SPEAKERS}/${ANA.id}` })
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'taken' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Já existe um falante com esse nome.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(screen.queryByLabelText('Nome')).toBeNull();
  });

  describe('a name suggested by voice (KBC-071 AC-2)', () => {
    const suggested = () =>
      speakers({
        status: 'done',
        diarization: aDiarization(),
        voiceSuggestions: [
          {
            voice: 2,
            speakerId: ANA.id,
            name: 'Mestre Gabriel',
            level: 'high',
          },
        ],
      });

    it('reads as a suggestion and names nobody until a person answers', async () => {
      await renderPanel(suggested());
      expect(
        screen.getByText(/Parece ser Mestre Gabriel/).textContent,
      ).toContain('semelhança alta');
      expect(
        screen.getByRole('button', {
          name: 'Aceitar Mestre Gabriel para a Voz 2',
        }),
      ).toBeTruthy();
    });

    it('sends the answer with the separation it was made on', async () => {
      const { http, fixture } = await renderPanel(suggested());
      fireEvent.click(
        screen.getByRole('button', {
          name: 'Recusar Mestre Gabriel para a Voz 2',
        }),
      );
      await fixture.whenStable();
      const sent = http.expectOne(`${VOICES}/2/suggestion`);
      expect(sent.request.body).toEqual({ version: 1, decision: 'refuse' });
      sent.flush(speakers({ status: 'done', diarization: aDiarization() }));
      await fixture.whenStable();
      expect(screen.queryByText(/Parece ser/)).toBeNull();
      expect(screen.getByText('Sugestão recusada.')).toBeTruthy();
    });
  });
});
