import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type { UploadCheck } from '@kb-chat/contracts';
import { TUS_UPLOAD } from '@core/media/tus-upload.js';
import { of } from 'rxjs';
import { aTopic } from '../../testing/fixtures.js';
import { FakeTus } from '../../testing/fake-tus.js';
import { aMediaItem } from '../../testing/media-fixtures.js';
import { AUDIO_LENGTH_READER } from './audio-length.js';
import { UploadPanel } from './upload-panel.js';

const CREATED = aMediaItem({
  status: 'uploading',
  durationMs: null,
  bytes: null,
});
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const TOPIC = '/api/v1/topics/hermetismo/media';

async function renderPanel() {
  const uploaded = vi.fn();
  const closed = vi.fn();
  const tus = new FakeTus();
  const view = await render(UploadPanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: TUS_UPLOAD, useValue: tus.factory },
      { provide: AUDIO_LENGTH_READER, useValue: () => of(60_000) },
    ],
    inputs: {
      topic: 'hermetismo',
      topics: [
        aTopic({ slug: 'hermetismo', title: 'Hermetismo', documentCount: 10 }),
        aTopic({ slug: 'alquimia', title: 'Alquimia', documentCount: 5 }),
      ],
    },
    on: { uploaded, closed },
  });
  await view.fixture.whenStable();
  const http = TestBed.inject(HttpTestingController);
  return { ...view, uploaded, closed, http, tus };
}

type Panel = Awaited<ReturnType<typeof renderPanel>>;

function choose(container: HTMLElement, ...files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

const audio = (name = 'Palestra_de_1998.mp3', size = 3) =>
  new File([new Uint8Array(size)], name, { type: 'audio/mpeg' });

/** Waits for the file's hash and answers the question the panel asks about it. */
async function answerCheck(
  { http, fixture }: Panel,
  verdict: UploadCheck = { verdict: 'new' },
  topic = TOPIC,
) {
  await vi.waitFor(() => http.expectOne(`${topic}/check`).flush(verdict));
  await fixture.whenStable();
}

async function chooseChecked(
  panel: Panel,
  file = audio(),
  verdict: UploadCheck = { verdict: 'new' },
) {
  choose(panel.container, file);
  await answerCheck(panel, verdict);
}

const clickSend = () =>
  fireEvent.click(
    screen.getByRole('button', { name: /^(Enviar|Tentar de novo)$/ }),
  );

/** Everything up to the file on its way. */
async function startSending(panel: Panel) {
  await chooseChecked(panel);
  clickSend();
  panel.http.expectOne(TOPIC).flush(CREATED);
  await panel.fixture.whenStable();
}

describe('UploadPanel (T14, KBC-034, KBC-035)', () => {
  it('opens as a dialog that says the rule before the choice (MA-20)', async () => {
    await renderPanel();
    expect(screen.getByRole('dialog', { name: 'Enviar áudio' })).toBeTruthy();
    expect(
      screen.getByText('mp3, m4a, wav, flac, ogg ou opus, até 4 GB cada'),
    ).toBeTruthy();
  });

  it('suggests the title from the file and refuses a file that is not audio (AC-8)', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel);
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Título' }).value,
    ).toBe('Palestra de 1998');
    choose(panel.container, audio('apostila.pdf'));
    await panel.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Este arquivo não é um áudio aceito. Envie mp3, m4a, wav, flac, ogg ou opus.',
    );
    panel.http.expectNone(`${TOPIC}/check`);
  });

  it('refuses a file over 4 GB before sending anything (KBC-035 AC-7)', async () => {
    const panel = await renderPanel();
    const huge = audio('imenso.wav');
    Object.defineProperty(huge, 'size', { value: 4.1 * 1024 ** 3 });
    choose(panel.container, huge);
    await panel.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Este arquivo tem 4,1 GB. O limite é 4 GB.',
    );
    clickSend();
    await panel.fixture.whenStable();
    expect(
      screen.getByText(
        'Nada a enviar: estes arquivos não podem ser enviados.',
        {
          exact: false,
        },
      ),
    ).toBeTruthy();
    panel.http.expectNone({ method: 'POST' });
  });

  it('shows the check of each file and holds "Enviar" until it ends (FR-1)', async () => {
    const panel = await renderPanel();
    choose(panel.container, audio());
    await panel.fixture.whenStable();
    expect(
      screen.getByRole<HTMLButtonElement>('button', {
        name: 'Conferindo arquivos…',
      }).disabled,
    ).toBe(true);
    await answerCheck(panel);
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
  });

  it('asks with the real hash and the length of the file (FR-1, FR-3)', async () => {
    const panel = await renderPanel();
    choose(panel.container, new File(['abc'], 'a.mp3'));
    let body: unknown;
    await vi.waitFor(() => {
      const call = panel.http.expectOne(`${TOPIC}/check`);
      body = call.request.body;
      call.flush({ verdict: 'new' });
    });
    expect(body).toEqual({
      sha256:
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      bytes: 3,
      durationMs: 60_000,
    });
  });

  it('says a repeated file is in the collection, links to it and sends nothing (AC-2)', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel, audio(), {
      verdict: 'duplicate',
      media: { id: CREATED.id, title: 'Palestra antiga' },
    });
    expect(screen.getByText(/Já está no acervo:/)).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Palestra antiga' })
        .getAttribute('href'),
    ).toBe(`/midia/${CREATED.id}`);
    expect(screen.queryByRole('textbox', { name: 'Título' })).toBeNull();
    clickSend();
    panel.http.expectNone({ method: 'POST' });
  });

  it('says the quota in the words of the item and sends nothing (AC-3)', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel, audio(), {
      verdict: 'over-quota',
      quotaBytes: 5 * 1024 ** 3,
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'Este envio passa da sua cota de 5 GB. Fale com um master para aumentar.',
    );
    clickSend();
    panel.http.expectNone({ method: 'POST' });
  });

  it('asks again when the collection changes (BR-2: the same collection)', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel, audio(), {
      verdict: 'duplicate',
      media: { id: CREATED.id, title: 'Palestra antiga' },
    });
    fireEvent.change(screen.getByRole('combobox', { name: 'Acervo' }), {
      target: { value: 'alquimia' },
    });
    await answerCheck(
      panel,
      { verdict: 'new' },
      '/api/v1/topics/alquimia/media',
    );
    expect(screen.queryByText(/Já está no acervo:/)).toBeNull();
  });

  it('continues an interrupted upload on the same item, with its title (FR-2)', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel, audio(), {
      verdict: 'resume',
      media: { id: CREATED.id, title: 'Título do primeiro envio' },
      offset: 1,
    });
    expect(screen.getByText(/Envio interrompido em/)).toBeTruthy();
    const title = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Título',
    });
    expect(title.value).toBe('Título do primeiro envio');
    expect(title.disabled).toBe(true);
    clickSend();
    panel.http.expectNone({ method: 'POST' });
    expect(panel.tus.last.options.uploadUrl).toBe(
      `/api/v1/media/${CREATED.id}/upload`,
    );
  });

  it('leaves an interrupted upload alone when the person only closes (FR-2)', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel, audio(), {
      verdict: 'resume',
      media: { id: CREATED.id, title: 'Primeiro envio' },
      offset: 1,
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    panel.http.expectNone({ method: 'DELETE' });
  });

  it('says an upload expired and sends it again as a new one (AC-6)', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel, audio(), { verdict: 'expired' });
    expect(screen.getByRole('alert').textContent).toContain(
      'Este envio expirou. Envie de novo.',
    );
    clickSend();
    panel.http.expectOne({ method: 'POST', url: TOPIC }).flush(CREATED);
    expect(panel.tus.sessions).toHaveLength(1);
  });

  it('says an upload that expired in the middle, and starts a new item (AC-6)', async () => {
    const panel = await renderPanel();
    await startSending(panel);
    panel.tus.last.fail(410);
    await panel.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Este envio expirou. Envie de novo.',
    );
    clickSend();
    panel.http.expectOne({ method: 'POST', url: TOPIC }).flush(CREATED);
    panel.http.expectNone({ method: 'DELETE' });
  });

  it('lets a check that failed through: creating the item decides the same rules', async () => {
    const panel = await renderPanel();
    choose(panel.container, audio());
    await vi.waitFor(() =>
      panel.http
        .expectOne(`${TOPIC}/check`)
        .flush(null, { status: 503, statusText: 'x' }),
    );
    await panel.fixture.whenStable();
    clickSend();
    panel.http.expectOne(TOPIC).flush(
      {
        error: {
          code: 'MEDIA_DUPLICATE',
          message: 'x',
          details: { media: { id: CREATED.id, title: 'Já enviado' } },
        },
      },
      { status: 409, statusText: 'x' },
    );
    await panel.fixture.whenStable();
    expect(screen.getByRole('link', { name: 'Já enviado' })).toBeTruthy();
    expect(panel.uploaded).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('says the quota when creating the item refuses it', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel);
    clickSend();
    panel.http.expectOne(TOPIC).flush(
      {
        error: {
          code: 'MEDIA_QUOTA_EXCEEDED',
          message: 'x',
          details: { quotaBytes: 1024 ** 3 },
        },
      },
      { status: 413, statusText: 'x' },
    );
    await panel.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain('cota de 1 GB');
  });

  it('asks for a file before sending, sending nothing', async () => {
    const { fixture, http } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await fixture.whenStable();
    expect(screen.getByText('Escolha um arquivo de áudio.')).toBeTruthy();
    http.expectNone(TOPIC);
  });

  it('has no author chosen in advance and says what a blank one means (SL-28, KBC-049)', async () => {
    await renderPanel();
    const author = screen.getByRole<HTMLInputElement>('combobox', {
      name: 'Autor',
    });
    expect(author.value).toBe('');
    expect(author.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(/Em branco, o áudio fica em/)).toBeTruthy();
  });

  it('creates the item, sends the file with real progress, then hands it over (AC-1)', async () => {
    const panel = await renderPanel();
    const { fixture, http, uploaded, tus } = panel;
    await chooseChecked(panel);
    const field = screen.getByRole('combobox', { name: 'Autor' });
    fireEvent.focus(field);
    fireEvent.input(field, { target: { value: ' Mestre Gabriel ' } });
    http
      .expectOne({ method: 'GET', url: '/api/v1/topics/hermetismo/authors' })
      .flush({ items: [] });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    // KBC-049 AC-1: the typed name is registered in the collection first.
    const author = http.expectOne({
      method: 'POST',
      url: '/api/v1/topics/hermetismo/authors',
    });
    expect(author.request.body).toEqual({ name: 'Mestre Gabriel' });
    author.flush({
      slug: 'mestre-gabriel',
      name: 'Mestre Gabriel',
      main: false,
    });
    const create = http.expectOne(TOPIC);
    expect(create.request.body).toMatchObject({
      title: 'Palestra de 1998',
      author: 'mestre-gabriel',
      fileName: 'Palestra_de_1998.mp3',
      bytes: 3,
      durationMs: 60_000,
    });
    create.flush(CREATED);
    tus.last.progress(1, 3);
    await fixture.whenStable();
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('33');
    expect(screen.getByText(/Enviando… 0 de 0 MB · 33%/)).toBeTruthy();
    tus.last.succeed();
    http
      .expectOne(`/api/v1/media/${CREATED.id}`)
      .flush({ ...CREATED, status: 'queued' });
    expect(uploaded).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued' }),
    );
  });

  it('sends three files at once, each with its progress said to a screen reader (AC-8)', async () => {
    const panel = await renderPanel();
    const { container, fixture, http, tus, uploaded } = panel;
    choose(container, audio('a.mp3'), audio('b.mp3', 4), audio('c.mp3', 5));
    await answerCheck(panel);
    await answerCheck(panel);
    await answerCheck(panel);
    clickSend();
    const created = http.match(TOPIC);
    expect(created).toHaveLength(3);
    created.forEach((call, i) =>
      call.flush({ ...CREATED, id: `${i + 1}`.repeat(8) + OTHER_ID.slice(8) }),
    );
    await fixture.whenStable();
    expect(tus.sessions).toHaveLength(3);
    tus.sessions[0]?.progress(2, 4);
    tus.sessions[1]?.progress(1, 4);
    await fixture.whenStable();
    expect(screen.getAllByRole('progressbar')).toHaveLength(3);
    expect(
      screen.getByRole('progressbar', { name: 'Progresso de b.mp3' }),
    ).toBeTruthy();
    const row = screen.getByRole('article', { name: 'a.mp3' });
    expect(within(row).getByText('a.mp3: 50% enviado.')).toBeTruthy();
    expect(
      within(row).getByText('a.mp3: 50% enviado.').getAttribute('aria-live'),
    ).toBe('polite');
    tus.sessions[0]?.progress(3, 4);
    await fixture.whenStable();
    // Steps of 25%: 75% is said, 74% would not be.
    expect(within(row).getByText('a.mp3: 75% enviado.')).toBeTruthy();
    for (const [i, session] of tus.sessions.entries()) {
      session.succeed();
      http
        .expectOne(`/api/v1/media/${`${i + 1}`.repeat(8)}${OTHER_ID.slice(8)}`)
        .flush(CREATED);
    }
    expect(uploaded).toHaveBeenCalledTimes(3);
  });

  it('keeps at most three files on their way', async () => {
    const panel = await renderPanel();
    const { container, http, tus, fixture } = panel;
    const names = ['a', 'b', 'c', 'd'];
    choose(container, ...names.map((name) => audio(`${name}.mp3`)));
    await answerCheck(panel);
    await answerCheck(panel);
    await answerCheck(panel);
    await answerCheck(panel);
    clickSend();
    http.match(TOPIC).forEach((call) => call.flush(CREATED));
    await fixture.whenStable();
    expect(tus.sessions).toHaveLength(3);
    tus.sessions[0]?.succeed();
    http.expectOne(`/api/v1/media/${CREATED.id}`).flush(CREATED);
    http.expectOne(TOPIC).flush(CREATED);
    expect(tus.sessions).toHaveLength(4);
  });

  it('keeps one file back without stopping the others, and retries only that one', async () => {
    const panel = await renderPanel();
    const { container, http, tus, fixture, uploaded } = panel;
    choose(container, audio('a.mp3'), audio('b.mp3', 4));
    await answerCheck(panel);
    await answerCheck(panel);
    clickSend();
    const [first, second] = http.match(TOPIC);
    first?.flush(CREATED);
    second?.flush({ ...CREATED, id: OTHER_ID });
    tus.sessions[0]?.fail();
    tus.sessions[1]?.succeed();
    http.expectOne(`/api/v1/media/${OTHER_ID}`).flush(CREATED);
    await fixture.whenStable();
    expect(screen.getByText('Enviado')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('O envio parou');
    expect(uploaded).toHaveBeenCalledTimes(1);
    clickSend();
    http.expectNone({ method: 'POST', url: TOPIC });
    expect(tus.sessions).toHaveLength(3);
  });

  it('lets a file off the list before sending', async () => {
    const panel = await renderPanel();
    choose(panel.container, audio('a.mp3'), audio('b.mp3', 4));
    await answerCheck(panel);
    await answerCheck(panel);
    fireEvent.click(
      screen.getByRole('button', { name: 'Tirar a.mp3 da lista' }),
    );
    await panel.fixture.whenStable();
    expect(screen.queryByText('a.mp3')).toBeNull();
    expect(screen.getByText('b.mp3')).toBeTruthy();
  });

  it('takes the same file only once', async () => {
    const panel = await renderPanel();
    const file = audio('a.mp3');
    await chooseChecked(panel, file);
    choose(panel.container, file);
    await panel.fixture.whenStable();
    expect(screen.getAllByText('a.mp3')).toHaveLength(1);
  });

  it('keeps the fields when the connection breaks and continues the same item (MA-26)', async () => {
    const panel = await renderPanel();
    const { fixture, http, uploaded, tus } = panel;
    await startSending(panel);
    tus.last.fail();
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'O envio parou: verifique a conexão e tente de novo.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    http.expectNone(TOPIC);
    expect(tus.sessions).toHaveLength(2);
    tus.last.succeed();
    http
      .expectOne(`/api/v1/media/${CREATED.id}`)
      .flush({ ...CREATED, status: 'queued' });
    expect(uploaded).toHaveBeenCalledTimes(1);
  });

  it('says it waits for the connection and goes back to the bar by itself (AC-1)', async () => {
    const panel = await renderPanel();
    const { fixture, tus } = panel;
    await startSending(panel);
    tus.last.progress(1);
    const cut = vi
      .spyOn(window.navigator, 'onLine', 'get')
      .mockReturnValue(false);
    tus.last.fail();
    await fixture.whenStable();
    const notice =
      'Sem conexão. O envio continua sozinho quando a rede voltar.';
    expect(screen.getAllByText(notice).length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('progressbar')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancelar envio' })).toBeTruthy();

    cut.mockReturnValue(true);
    window.dispatchEvent(new Event('online'));
    tus.last.progress(2);
    await fixture.whenStable();
    expect(screen.queryByText(notice)).toBeNull();
    expect(tus.last.starts).toBe(2);
    cut.mockRestore();
  });

  it('says when the bytes came out different and the upload starts over', async () => {
    const panel = await renderPanel();
    await startSending(panel);
    panel.tus.last.fail(
      400,
      JSON.stringify({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'x',
          details: { field: 'sha256' },
        },
      }),
    );
    await panel.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'O arquivo chegou diferente do original.',
    );
  });

  it('explains a file the server refused', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel);
    clickSend();
    panel.http
      .expectOne(TOPIC)
      .flush(
        { error: { code: 'VALIDATION_FAILED', message: 'x' } },
        { status: 400, statusText: 'Bad Request' },
      );
    await panel.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Envie um áudio de até 4 GB (mp3, m4a, wav, flac, ogg ou opus).',
    );
  });

  it('cancels a running upload and removes the half-sent item', async () => {
    const panel = await renderPanel();
    await startSending(panel);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }));
    expect(panel.tus.last.aborted).toBe(true);
    panel.http
      .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
      .flush(null);
  });

  it('warns before leaving the page only while sending', async () => {
    const panel = await renderPanel();
    const idle = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
    await startSending(panel);
    const sending = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(sending);
    expect(sending.defaultPrevented).toBe(true);
  });

  it('accepts dropped files and closes with "Cancelar"', async () => {
    const panel = await renderPanel();
    const { container, fixture, closed } = panel;
    const zone = container.querySelector('.drop');
    if (!zone) throw new Error('no drop zone');
    fireEvent.dragOver(zone);
    await fixture.whenStable();
    expect(zone.classList.contains('dragging')).toBe(true);
    fireEvent.drop(zone, {
      dataTransfer: { files: [audio('aula.flac'), audio('outra.flac', 4)] },
    });
    await fixture.whenStable();
    expect(screen.getByText('aula.flac')).toBeTruthy();
    expect(screen.getByText('outra.flac')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it('keeps the upload resumable when Escape closes the panel mid-upload (FR-2)', async () => {
    const panel = await renderPanel();
    await startSending(panel);
    screen.getByRole('dialog').dispatchEvent(new Event('close'));
    expect(panel.tus.last.aborted).toBe(true);
    panel.http.expectNone({ method: 'DELETE' });
    expect(panel.closed).toHaveBeenCalledTimes(1);
  });

  it('keeps the upload resumable when the page goes away (FR-2)', async () => {
    const panel = await renderPanel();
    await startSending(panel);
    panel.fixture.destroy();
    expect(panel.tus.last.aborted).toBe(true);
    panel.http.expectNone({ method: 'DELETE' });
  });

  it('removes the created item when the person gives up after a failure', async () => {
    const panel = await renderPanel();
    await startSending(panel);
    panel.tus.last.fail();
    await panel.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    panel.http
      .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
      .flush(null);
  });

  it('creates a new item when the title changed after a failure, removing the old one', async () => {
    const panel = await renderPanel();
    await startSending(panel);
    panel.tus.last.fail();
    await panel.fixture.whenStable();
    fireEvent.input(screen.getByRole('textbox', { name: 'Título' }), {
      target: { value: 'Outro título' },
    });
    clickSend();
    panel.http
      .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
      .flush(null);
    const again = panel.http.expectOne(TOPIC);
    expect(again.request.body).toMatchObject({ title: 'Outro título' });
    again.flush({ ...CREATED, id: OTHER_ID });
    expect(panel.tus.last.options.uploadUrl).toBe(
      `/api/v1/media/${OTHER_ID}/upload`,
    );
  });

  it("sends nothing while the author's name breaks the API's rule (KBC-049 QA)", async () => {
    const panel = await renderPanel();
    await chooseChecked(panel);
    const field = screen.getByRole('combobox', { name: 'Autor' });
    fireEvent.input(field, { target: { value: 'Mestre "Gabriel"' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await panel.fixture.whenStable();

    panel.http.expectNone({ method: 'POST' });
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('tells a refused author as an author problem, never as the file (KBC-049 QA)', async () => {
    const panel = await renderPanel();
    const { fixture, http } = panel;
    await chooseChecked(panel);
    fireEvent.input(screen.getByRole('combobox', { name: 'Autor' }), {
      target: { value: 'Mestre Gabriel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    http
      .expectOne({ method: 'POST', url: '/api/v1/topics/hermetismo/authors' })
      .flush(
        {
          error: {
            code: 'VALIDATION_FAILED',
            message: 'x',
            details: { field: 'name' },
          },
        },
        { status: 400, statusText: 'Bad Request' },
      );
    await fixture.whenStable();

    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).toContain('O nome do autor não foi aceito');
    expect(alert).not.toContain('4 GB');
    http.expectNone(TOPIC);
  });

  it('registers a new author once for all the files', async () => {
    const panel = await renderPanel();
    const { container, http } = panel;
    choose(container, audio('a.mp3'), audio('b.mp3', 4));
    await answerCheck(panel);
    await answerCheck(panel);
    fireEvent.input(screen.getByRole('combobox', { name: 'Autor' }), {
      target: { value: 'Mestre Gabriel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    http
      .expectOne({ method: 'POST', url: '/api/v1/topics/hermetismo/authors' })
      .flush({ slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: false });
    expect(http.match(TOPIC)).toHaveLength(2);
  });

  it('tells an author the collection lost as an author problem too', async () => {
    const panel = await renderPanel();
    const { fixture, http } = panel;
    await chooseChecked(panel);
    fireEvent.input(screen.getByRole('combobox', { name: 'Autor' }), {
      target: { value: 'Mestre Gabriel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    http
      .expectOne({ method: 'POST', url: '/api/v1/topics/hermetismo/authors' })
      .flush({ slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: false });
    http.expectOne(TOPIC).flush(
      {
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Unknown author',
          details: { field: 'author' },
        },
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await fixture.whenStable();

    expect(screen.getByRole('alert').textContent).toContain(
      'O nome do autor não foi aceito',
    );
  });

  it('refuses a title of only spaces before sending, and sends it trimmed', async () => {
    const panel = await renderPanel();
    const { http, fixture } = panel;
    await chooseChecked(panel);
    const title = screen.getByRole('textbox', { name: 'Título' });
    fireEvent.input(title, { target: { value: '   ' } });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await fixture.whenStable();
    expect(screen.getByText(/Dê um título ao áudio\./)).toBeTruthy();
    expect(title.getAttribute('aria-invalid')).toBe('true');
    http.expectNone({ method: 'POST' });
    fireEvent.input(title, { target: { value: '  Aula 3  ' } });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    const created = http.expectOne({ method: 'POST' });
    expect(created.request.body).toMatchObject({
      title: 'Aula 3',
      author: null,
    });
    created.flush(CREATED);
  });

  it('keeps a title the person typed when another file is chosen', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel);
    const title = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Título',
    });
    fireEvent.input(title, { target: { value: 'Meu título' } });
    await chooseChecked(panel, audio('Outra.mp3'));
    expect(title.value).toBe('Meu título');
    expect(screen.getAllByRole('textbox', { name: 'Título' })).toHaveLength(2);
  });

  it('sends to the collection chosen in "Acervo"', async () => {
    const panel = await renderPanel();
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Acervo',
    });
    expect(select.value).toBe('hermetismo');
    fireEvent.change(select, { target: { value: 'alquimia' } });
    const alquimia = '/api/v1/topics/alquimia/media';
    choose(panel.container, audio());
    await answerCheck(panel, { verdict: 'new' }, alquimia);
    clickSend();
    panel.http.expectOne(alquimia).flush(CREATED);
    expect(panel.tus.sessions).toHaveLength(1);
  });
});
