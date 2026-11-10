import {
  HttpErrorResponse,
  provideHttpClient,
  withInterceptors,
  type HttpInterceptorFn,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type {
  Feature,
  PreparationOptions,
  Topic,
  UploadCheck,
} from '@kb-chat/contracts';
import { TUS_UPLOAD } from '@core/media/tus-upload.js';
import { of, throwError } from 'rxjs';
import { aTopic } from '../../testing/fixtures.js';
import {
  QS_CI,
  answeringLevels,
  holdingLevels,
} from '../../testing/level-fixtures.js';
import { FakeTus } from '../../testing/fake-tus.js';
import { aMediaItem, sessionAs } from '../../testing/media-fixtures.js';
import {
  aPreparation,
  anOffer,
  answeringOptions,
} from '../../testing/preparation-fixtures.js';
import { AUDIO_LENGTH_READER, type AudioLengthReader } from './audio-length.js';
import { UploadPanel } from './upload-panel.js';

const CREATED = aMediaItem({
  status: 'uploading',
  durationMs: null,
  bytes: null,
});
const OTHER_ID = '22222222-2222-4222-8222-222222222222';
const TOPIC = '/api/v1/topics/hermetismo/media';
const TOPICS = [
  aTopic({ slug: 'hermetismo', title: 'Hermetismo', documentCount: 10 }),
  aTopic({ slug: 'alquimia', title: 'Alquimia', documentCount: 5 }),
];

async function renderPanel(
  options: {
    readonly features?: Feature[];
    readonly length?: AudioLengthReader;
    readonly offer?: PreparationOptions;
    readonly topic?: string;
    readonly topics?: Topic[];
    readonly scales?: Parameters<typeof answeringLevels>[0];
    /** Interceptors before the answering ones (a held answer). */
    readonly before?: HttpInterceptorFn[];
  } = {},
) {
  const uploaded = vi.fn();
  const closed = vi.fn();
  const tus = new FakeTus();
  const asked: string[] = [];
  const view = await render(UploadPanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(
        withInterceptors([
          ...(options.before ?? []),
          answeringOptions(options.offer, asked),
          answeringLevels(options.scales),
        ]),
      ),
      provideHttpClientTesting(),
      provideRouter([
        { path: 'midia/:id/preparar', children: [] },
        { path: 'fila', children: [] },
      ]),
      sessionAs({ features: options.features ?? ['media', 'media-upload'] }),
      { provide: TUS_UPLOAD, useValue: tus.factory },
      {
        provide: AUDIO_LENGTH_READER,
        useValue: options.length ?? (() => of(60_000)),
      },
    ],
    inputs: {
      topic: options.topic ?? 'hermetismo',
      topics: options.topics ?? TOPICS,
    },
    on: { uploaded, closed },
  });
  await view.fixture.whenStable();
  const http = TestBed.inject(HttpTestingController);
  return { ...view, uploaded, closed, http, tus, asked };
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

  it('opened before the collections are known, it takes the selected one when they come', async () => {
    const panel = await renderPanel({ topic: '', topics: [] });
    panel.fixture.componentRef.setInput('topics', TOPICS);
    panel.fixture.componentRef.setInput('topic', 'hermetismo');
    await panel.fixture.whenStable();
    expect((screen.getByLabelText('Acervo') as HTMLSelectElement).value).toBe(
      'hermetismo',
    );
    await chooseChecked(panel);
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

  it('warns of the same file in another part of the collection, and still sends (KBC-091)', async () => {
    const panel = await renderPanel();
    await chooseChecked(panel, audio(), {
      verdict: 'new',
      elsewhere: [
        { id: OTHER_ID, title: 'Palestra antiga', topic: 'hermetismo' },
      ],
    });
    expect(screen.getByText(/Também está em Hermetismo:/)).toBeTruthy();
    expect(screen.getByText(/Pode enviar assim mesmo/)).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Palestra antiga' })
        .getAttribute('href'),
    ).toBe(`/midia/${OTHER_ID}`);
    expect(screen.getByRole('textbox', { name: 'Título' })).toBeTruthy();
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

  it('fails only the file that cannot be read, and goes on with the next', async () => {
    const panel = await renderPanel();
    const gone = audio('sumiu.mp3');
    vi.spyOn(gone, 'slice').mockReturnValue(
      Object.assign(new Blob(), {
        arrayBuffer: () =>
          Promise.reject(new DOMException('gone', 'NotReadableError')),
      }),
    );
    choose(panel.container, gone, audio('fica.mp3'));
    await answerCheck(panel);
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Não foi possível ler este arquivo. Tire-o da lista e escolha de novo.',
    );
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
  });

  it('stops hashing a file taken off the list', async () => {
    const panel = await renderPanel();
    const large = audio('grande.mp3', 3 * 1024 ** 2);
    const slice = vi.spyOn(large, 'slice');
    let read: (bytes: ArrayBuffer) => void = () => undefined;
    slice.mockReturnValue(
      Object.assign(new Blob(), {
        arrayBuffer: () =>
          new Promise<ArrayBuffer>((resolve) => (read = resolve)),
      }),
    );
    choose(panel.container, large);
    await panel.fixture.whenStable();
    await vi.waitFor(() => expect(slice).toHaveBeenCalledTimes(1));
    fireEvent.click(
      screen.getByRole('button', { name: 'Tirar grande.mp3 da lista' }),
    );
    read(new ArrayBuffer(1024 ** 2));
    await panel.fixture.whenStable();
    await chooseChecked(panel, audio('outro.mp3'));
    expect(slice).toHaveBeenCalledTimes(1);
  });

  it('ignores the answer of a check from the collection the person left (BR-2)', async () => {
    const panel = await renderPanel();
    const { http, fixture } = panel;
    choose(panel.container, audio());
    const stale = await vi.waitFor(() => http.expectOne(`${TOPIC}/check`));
    fireEvent.change(screen.getByRole('combobox', { name: 'Acervo' }), {
      target: { value: 'alquimia' },
    });
    stale.flush({
      verdict: 'duplicate',
      media: { id: CREATED.id, title: 'Palestra antiga' },
    });
    await fixture.whenStable();
    await answerCheck(
      panel,
      { verdict: 'new' },
      '/api/v1/topics/alquimia/media',
    );
    expect(screen.queryByText(/Já está no acervo:/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
  });

  it('locks "Acervo" while sending, and frees it once the upload stopped (T14, AC-8)', async () => {
    const panel = await renderPanel();
    const { fixture, tus } = panel;
    const field = () =>
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Acervo' });
    expect(field().disabled).toBe(false);
    await startSending(panel);
    expect(field().disabled).toBe(true);
    tus.last.fail();
    await fixture.whenStable();
    expect(field().disabled).toBe(false);
    expect(field().value).toBe('hermetismo');
  });

  it('frees "Acervo" after "Cancelar envio"', async () => {
    const panel = await renderPanel();
    const { fixture, http } = panel;
    await startSending(panel);
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }));
    http.expectOne(`/api/v1/media/${CREATED.id}`).flush(null);
    await fixture.whenStable();
    expect(
      screen.getByRole<HTMLSelectElement>('combobox', { name: 'Acervo' })
        .disabled,
    ).toBe(false);
  });

  it('keeps a file that was sent as sent when the collection changes after a stop', async () => {
    const panel = await renderPanel();
    const { container, http, fixture, tus } = panel;
    choose(container, audio('a.mp3'), audio('b.mp3'));
    await answerCheck(panel);
    await answerCheck(panel);
    clickSend();
    for (const request of http.match(TOPIC)) request.flush(CREATED);
    await fixture.whenStable();
    const [first, second] = tus.sessions;
    first?.succeed();
    http.expectOne(`/api/v1/media/${CREATED.id}`).flush(CREATED);
    second?.fail();
    await fixture.whenStable();
    fireEvent.change(screen.getByRole('combobox', { name: 'Acervo' }), {
      target: { value: 'alquimia' },
    });
    await answerCheck(
      panel,
      { verdict: 'new' },
      '/api/v1/topics/alquimia/media',
    );
    expect(screen.getByText('Enviado')).toBeTruthy();
    http.expectNone('/api/v1/topics/alquimia/media/check');
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

  describe('the choices of step 1, on each file (KBC-072)', () => {
    const EDITOR: Feature[] = ['media', 'media-upload', 'media-edit'];
    const PAID: Feature[] = [...EDITOR, 'media-edit-ai'];
    const SECOND_ID = '33333333-3333-4333-8333-333333333333';
    const TRANSCRIBE_ONLY = {
      transcribe: true,
      speakers: false,
      tracks: 'none',
    };

    beforeEach(() => localStorage.clear());

    const lengthsAsked = ({ asked }: Panel) =>
      asked.map((url) =>
        new URL(url, 'http://x').searchParams.get('durationMs'),
      );

    /** The file's last byte and the item as the API then has it. */
    async function finish(
      { fixture, http, tus }: Panel,
      id = CREATED.id,
      i = 0,
    ) {
      tus.sessions[i]?.succeed();
      http
        .expectOne(`/api/v1/media/${id}`)
        .flush({ ...CREATED, id, status: 'queued' });
      await fixture.whenStable();
    }

    async function chooseAi({ fixture }: Panel) {
      fireEvent.click(
        screen.getByRole('radio', { name: 'Propor as faixas com IA' }),
      );
      await fixture.whenStable();
    }

    const planOf = (body: unknown) => (body as { plan?: object }).plan;

    it('shows step 1 of 4 to who edits, and no flow to who only sends (AC-15)', async () => {
      await renderPanel({ features: EDITOR });
      expect(screen.getByTestId('step-text').textContent).toContain(
        'Passo 1 de 4',
      );
      expect(
        screen.getByRole('group', { name: 'O que fazer com este áudio' }),
      ).toBeTruthy();
    });

    it('hides the steps from who may only send (AC-15)', async () => {
      await renderPanel();
      expect(screen.queryByTestId('step-text')).toBeNull();
    });

    it('asks for the estimates with the length of the file (BR-4)', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel);
      expect(lengthsAsked(panel).at(-1)).toBe('60000');
    });

    it('asks for the sum of the files and calls the choices theirs', async () => {
      const panel = await renderPanel({ features: EDITOR });
      choose(panel.container, audio('a.mp3'), audio('b.mp3', 4));
      await answerCheck(panel);
      await answerCheck(panel);
      expect(lengthsAsked(panel).at(-1)).toBe('120000');
      expect(
        screen.getByRole('group', { name: 'O que fazer com estes áudios' }),
      ).toBeTruthy();
    });

    it('leaves a repeated file out of the sum', async () => {
      const panel = await renderPanel({ features: EDITOR });
      choose(panel.container, audio('a.mp3'), audio('b.mp3', 4));
      await answerCheck(panel);
      await answerCheck(panel, {
        verdict: 'duplicate',
        media: { id: OTHER_ID, title: 'Já enviado' },
      });
      expect(lengthsAsked(panel).at(-1)).toBe('60000');
    });

    it('estimates nothing while one of the lengths is unknown (BR-4)', async () => {
      const panel = await renderPanel({
        features: PAID,
        length: (file) => of(file.size === 3 ? 60_000 : null),
      });
      choose(panel.container, audio('a.mp3'), audio('b.mp3', 4));
      await answerCheck(panel);
      await answerCheck(panel);
      expect(lengthsAsked(panel).at(-1)).toBeNull();
    });

    it('estimates nothing past the longest length the API takes', async () => {
      const panel = await renderPanel({
        features: EDITOR,
        length: () => of(50_000_000),
      });
      choose(panel.container, audio('a.mp3'), audio('b.mp3', 4));
      await answerCheck(panel);
      await answerCheck(panel);
      expect(lengthsAsked(panel).at(-1)).toBeNull();
    });

    it('goes to step 2 after one file with more than the transcription', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel);
      clickSend();
      const create = panel.http.expectOne(TOPIC);
      expect(planOf(create.request.body)).toMatchObject({
        transcribe: true,
        speakers: true,
        tracks: 'none',
        acceptedUsd: null,
      });
      create.flush(CREATED);
      await panel.fixture.whenStable();
      await finish(panel);
      expect(panel.uploaded).toHaveBeenCalledTimes(1);
      expect(TestBed.inject(Router).url).toBe(`/midia/${CREATED.id}/preparar`);
    });

    it('with only "Transcrever", goes back to the list as ever (AC-15)', async () => {
      const panel = await renderPanel();
      await chooseChecked(panel);
      clickSend();
      const create = panel.http.expectOne(TOPIC);
      expect(planOf(create.request.body)).toMatchObject(TRANSCRIBE_ONLY);
      create.flush(CREATED);
      await panel.fixture.whenStable();
      await finish(panel);
      expect(panel.uploaded).toHaveBeenCalledTimes(1);
      expect(TestBed.inject(Router).url).toBe('/');
    });

    it('sends the plan with every file and goes to the queue after several (KBC-090)', async () => {
      const panel = await renderPanel({ features: EDITOR });
      const { container, fixture, http, uploaded } = panel;
      choose(container, audio('a.mp3'), audio('b.mp3', 4));
      await answerCheck(panel);
      await answerCheck(panel);
      clickSend();
      const [first, second] = http.match(TOPIC);
      expect(planOf(first?.request.body)).toMatchObject({ speakers: true });
      expect(planOf(second?.request.body)).toMatchObject({ speakers: true });
      first?.flush(CREATED);
      second?.flush({ ...CREATED, id: SECOND_ID });
      await fixture.whenStable();
      await finish(panel, CREATED.id, 0);
      await finish(panel, SECOND_ID, 1);
      expect(uploaded).toHaveBeenCalledTimes(2);
      await fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe('/fila');
    });

    it('gives each file its share of the value seen, by length (BR-4)', async () => {
      const panel = await renderPanel({
        features: PAID,
        length: (file) => of(file.size === 3 ? 60_000 : 180_000),
      });
      choose(panel.container, audio('a.mp3'), audio('b.mp3', 4));
      await answerCheck(panel);
      await answerCheck(panel);
      await chooseAi(panel);
      clickSend();
      const [first, second] = panel.http.match(TOPIC);
      const usd = (call: typeof first) =>
        (planOf(call?.request.body) as { acceptedUsd: number }).acceptedUsd;
      expect(usd(first)).toBeCloseTo(0.005, 5);
      expect(usd(second)).toBeCloseTo(0.015, 5);
      first?.flush({}, { status: 500, statusText: 'x' });
      second?.flush({}, { status: 500, statusText: 'x' });
    });

    it('sends the whole value seen with a single file (AC-3)', async () => {
      const panel = await renderPanel({ features: PAID });
      await chooseChecked(panel);
      await chooseAi(panel);
      clickSend();
      const create = panel.http.expectOne(TOPIC);
      expect(planOf(create.request.body)).toMatchObject({
        tracks: 'ai',
        acceptedUsd: 0.02,
      });
      create.flush({}, { status: 500, statusText: 'x' });
    });

    it('goes to step 2 when one file went and the others were repeated (Q177)', async () => {
      const panel = await renderPanel({ features: EDITOR });
      choose(panel.container, audio('a.mp3'), audio('b.mp3', 4));
      await answerCheck(panel);
      await answerCheck(panel, {
        verdict: 'duplicate',
        media: { id: OTHER_ID, title: 'Já enviado' },
      });
      clickSend();
      panel.http.expectOne(TOPIC).flush(CREATED);
      await panel.fixture.whenStable();
      await finish(panel);
      expect(TestBed.inject(Router).url).toBe(`/midia/${CREATED.id}/preparar`);
    });

    it('keeps the item of a file that stopped when another joins and the value moves', async () => {
      const panel = await renderPanel({ features: PAID });
      await chooseChecked(panel);
      await chooseAi(panel);
      clickSend();
      panel.http.expectOne(TOPIC).flush(CREATED);
      await panel.fixture.whenStable();
      panel.tus.last.fail(500);
      await panel.fixture.whenStable();
      choose(panel.container, audio('b.mp3', 4));
      await answerCheck(panel);
      clickSend();
      await panel.fixture.whenStable();
      panel.http.expectNone({ method: 'DELETE' });
      expect(panel.http.match(TOPIC)).toHaveLength(1);
      expect(panel.tus.sessions[1]?.options.uploadUrl).toBe(
        `/api/v1/media/${CREATED.id}/upload`,
      );
    });

    it('starts a new item when the person changes the choices after a stop', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel);
      clickSend();
      panel.http.expectOne(TOPIC).flush(CREATED);
      await panel.fixture.whenStable();
      panel.tus.last.fail(500);
      await panel.fixture.whenStable();
      fireEvent.click(
        screen.getByRole('checkbox', { name: 'Indicar quem está falando' }),
      );
      await panel.fixture.whenStable();
      clickSend();
      panel.http
        .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
        .flush(null);
      await panel.fixture.whenStable();
      const create = panel.http.expectOne(TOPIC);
      expect(planOf(create.request.body)).toMatchObject({ speakers: false });
      create.flush(CREATED);
    });

    const RESUME: UploadCheck = {
      verdict: 'resume',
      media: { id: CREATED.id, title: 'Primeiro envio' },
      offset: 1,
    };

    it('resumes with the plan on the server, without asking again, up to step 2', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel, audio(), RESUME);
      expect(
        screen.queryByRole('group', { name: 'O que fazer com este áudio' }),
      ).toBeNull();
      expect(screen.getByText(/mantém as escolhas daquele envio/)).toBeTruthy();
      clickSend();
      panel.http.expectNone({ method: 'POST' });
      await panel.fixture.whenStable();
      await finish(panel);
      panel.http
        .expectOne(`/api/v1/media/${CREATED.id}/preparation`)
        .flush(aPreparation({ mediaId: CREATED.id }));
      await panel.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe(`/midia/${CREATED.id}/preparar`);
    });

    it('stays on the list when what was resumed has no open plan', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel, audio(), RESUME);
      clickSend();
      await panel.fixture.whenStable();
      await finish(panel);
      panel.http
        .expectOne(`/api/v1/media/${CREATED.id}/preparation`)
        .flush(aPreparation({ mediaId: CREATED.id, plan: null }));
      await panel.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe('/');
    });

    it('stays on the list when the plan of what was resumed cannot be read', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel, audio(), RESUME);
      clickSend();
      await panel.fixture.whenStable();
      await finish(panel);
      panel.http
        .expectOne(`/api/v1/media/${CREATED.id}/preparation`)
        .flush({}, { status: 500, statusText: 'x' });
      await panel.fixture.whenStable();
      expect(TestBed.inject(Router).url).toBe('/');
    });

    it('does not ask for a plan who may only send', async () => {
      const panel = await renderPanel();
      await chooseChecked(panel, audio(), RESUME);
      clickSend();
      await panel.fixture.whenStable();
      await finish(panel);
      panel.http.expectNone(`/api/v1/media/${CREATED.id}/preparation`);
    });

    it('applies the choices only to the new file when one resumes beside it', async () => {
      const panel = await renderPanel({ features: EDITOR });
      choose(panel.container, audio('a.mp3'), audio('b.mp3', 4));
      await answerCheck(panel, RESUME);
      await answerCheck(panel);
      expect(lengthsAsked(panel).at(-1)).toBe('60000');
      expect(screen.getByText(/mantém as escolhas daquele envio/)).toBeTruthy();
      clickSend();
      const creates = panel.http.match(TOPIC);
      expect(creates).toHaveLength(1);
      expect(creates[0]?.request.body).toMatchObject({ fileName: 'b.mp3' });
      creates[0]?.flush({ ...CREATED, id: SECOND_ID });
    });

    it('offers the choices again when a resumed upload is cancelled', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel, audio(), RESUME);
      clickSend();
      await panel.fixture.whenStable();
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }));
      panel.http
        .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
        .flush(null);
      await panel.fixture.whenStable();
      expect(
        screen.getByRole('group', { name: 'O que fazer com este áudio' }),
      ).toBeTruthy();
    });

    it('keeps a resumed title locked when the file stops again (T14, Q188)', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel, audio(), RESUME);
      clickSend();
      await panel.fixture.whenStable();
      panel.tus.last.fail(500);
      await panel.fixture.whenStable();
      const title = screen.getByRole<HTMLInputElement>('textbox', {
        name: 'Título',
      });
      expect(title.disabled).toBe(true);
    });

    /** Four files with the AI chosen, three on their way and the fourth waiting. */
    async function sendFourWithAi(panel: Panel) {
      const names = ['a.mp3', 'b.mp3', 'c.mp3', 'd.mp3'];
      choose(panel.container, ...names.map((name, i) => audio(name, 3 + i)));
      let unchecked = names.length;
      while (unchecked-- > 0) await answerCheck(panel);
      await chooseAi(panel);
      clickSend();
      await panel.fixture.whenStable();
      return panel.http.match(TOPIC);
    }

    it('keeps the plan and the sum of the click for a file that starts later', async () => {
      const panel = await renderPanel({ features: PAID });
      const [first, second, third] = await sendFourWithAi(panel);
      first?.flush(
        {
          error: {
            code: 'MEDIA_DUPLICATE',
            message: 'x',
            details: { media: { id: OTHER_ID, title: 'Já enviado' } },
          },
        },
        { status: 409, statusText: 'Conflict' },
      );
      await panel.fixture.whenStable();
      const [fourth] = panel.http.match(TOPIC);
      expect(planOf(fourth?.request.body)).toMatchObject({
        tracks: 'ai',
        acceptedUsd: 0.005,
      });
      for (const call of [second, third, fourth])
        call?.flush({}, { status: 500, statusText: 'x' });
    });

    it('takes no file dropped while sending, and says so (T14)', async () => {
      const panel = await renderPanel({ features: PAID });
      const calls = await sendFourWithAi(panel);
      const zone = panel.container.querySelector('.drop');
      if (!zone) throw new Error('no drop zone');
      fireEvent.drop(zone, { dataTransfer: { files: [audio('tarde.mp3')] } });
      await panel.fixture.whenStable();
      expect(screen.queryByText('tarde.mp3')).toBeNull();
      expect(screen.getByRole('alert').textContent).toContain(
        'Espere o envio terminar para adicionar arquivos.',
      );
      for (const call of calls)
        call.flush({}, { status: 500, statusText: 'x' });
      await panel.fixture.whenStable();
      panel.http
        .match(TOPIC)
        .forEach((call) => call.flush({}, { status: 500, statusText: 'x' }));
      await panel.fixture.whenStable();
      expect(screen.queryByText(/Espere o envio terminar/)).toBeNull();
    });

    it('tells the file already arrived when its item cannot be replaced, and creates none', async () => {
      const panel = await renderPanel({ features: PAID });
      await chooseChecked(panel);
      await chooseAi(panel);
      clickSend();
      panel.http.expectOne(TOPIC).flush(CREATED);
      await panel.fixture.whenStable();
      panel.tus.last.fail();
      await panel.fixture.whenStable();
      fireEvent.click(screen.getByRole('radio', { name: 'Não dividir agora' }));
      await panel.fixture.whenStable();
      clickSend();
      panel.http
        .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
        .flush(
          { error: { code: 'FORBIDDEN', message: 'x' } },
          { status: 403, statusText: 'Forbidden' },
        );
      await panel.fixture.whenStable();
      panel.http.expectNone(TOPIC);
      const said = screen.getByRole('alert').textContent;
      expect(said).toContain('já tinha chegado');
      expect(said).toMatch(/IA paga de até .*0[.,]025/);
    });

    it('still replaces the item when the removal fails for another reason', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await startSending(panel);
      panel.tus.last.fail();
      await panel.fixture.whenStable();
      fireEvent.input(screen.getByRole('textbox', { name: 'Título' }), {
        target: { value: 'Outro título' },
      });
      clickSend();
      panel.http
        .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
        .flush({}, { status: 500, statusText: 'x' });
      await panel.fixture.whenStable();
      panel.http.expectOne(TOPIC).flush({ ...CREATED, id: OTHER_ID });
    });

    const NO_ESTIMATE = anOffer({ aiEstimateUsd: null });
    const aiReason = () =>
      screen.getByRole('radio', { name: 'Propor as faixas com IA' })
        .parentElement?.parentElement?.textContent ?? '';

    it('says the 24 h limit past it, not that a file cannot be read (UP-11)', async () => {
      const panel = await renderPanel({
        features: PAID,
        offer: NO_ESTIMATE,
        length: () => of(50_000_000),
      });
      choose(panel.container, audio('a.mp3'), audio('b.mp3', 4));
      await answerCheck(panel);
      await answerCheck(panel);
      expect(aiReason()).toContain('passa de 24 h');
      expect(aiReason()).not.toContain('consiga ler');
    });

    it('asks for a readable file when a length is unknown (BR-4)', async () => {
      const panel = await renderPanel({
        features: PAID,
        offer: NO_ESTIMATE,
        length: () => of(null),
      });
      await chooseChecked(panel);
      expect(aiReason()).toContain('consiga ler');
    });

    const keptWith = (acceptedUsd: number | null, tracks = 'ai' as const) =>
      aPreparation({
        mediaId: CREATED.id,
        plan: {
          transcribe: true,
          speakers: true,
          tracks,
          subjects: false,
          acceptedUsd,
        },
      });

    it('says the plan kept is paid, and its value (Q188)', async () => {
      const panel = await renderPanel({ features: PAID });
      await chooseChecked(panel, audio(), RESUME);
      panel.http
        .expectOne(`/api/v1/media/${CREATED.id}/preparation`)
        .flush(keptWith(0.0016));
      await panel.fixture.whenStable();
      expect(
        screen.getByText(/mantém as escolhas daquele envio/).textContent,
      ).toMatch(/IA paga de até .*0[.,]002\b/);
    });

    it('says only that the choices stay when the plan kept is free or unread', async () => {
      const panel = await renderPanel({ features: PAID });
      await chooseChecked(panel, audio(), RESUME);
      panel.http
        .expectOne(`/api/v1/media/${CREATED.id}/preparation`)
        .flush({}, { status: 500, statusText: 'x' });
      await panel.fixture.whenStable();
      const notice = screen.getByText(/mantém as escolhas daquele envio/);
      expect(notice.textContent).not.toContain('IA paga');
      expect(screen.getByText(/Envio interrompido em/)).toBeTruthy();
    });

    it('takes the choices away while sending and brings them back after a stop', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel);
      clickSend();
      panel.http.expectOne(TOPIC).flush(CREATED);
      await panel.fixture.whenStable();
      expect(
        screen.queryByRole('group', { name: 'O que fazer com este áudio' }),
      ).toBeNull();
      expect(screen.getByRole('progressbar')).toBeTruthy();
      panel.tus.last.fail(500);
      await panel.fixture.whenStable();
      expect(
        screen.getByRole('group', { name: 'O que fazer com este áudio' }),
      ).toBeTruthy();
    });

    it('sends nothing for a repeated file, whatever the plan (AC-2)', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel, audio(), {
        verdict: 'duplicate',
        media: { id: OTHER_ID, title: 'Já enviado' },
      });
      clickSend();
      await panel.fixture.whenStable();
      panel.http.expectNone({ method: 'POST' });
      expect(TestBed.inject(Router).url).toBe('/');
    });

    it('keeps the panel and goes nowhere when the API calls the file repeated', async () => {
      const panel = await renderPanel({ features: EDITOR });
      await chooseChecked(panel);
      clickSend();
      panel.http.expectOne(TOPIC).flush(
        {
          error: {
            code: 'MEDIA_DUPLICATE',
            message: 'x',
            details: { media: { id: OTHER_ID, title: 'Já enviado' } },
          },
        },
        { status: 409, statusText: 'Conflict' },
      );
      await panel.fixture.whenStable();
      expect(screen.getByRole('dialog', { name: 'Enviar áudio' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Já enviado' })).toBeTruthy();
      expect(panel.uploaded).not.toHaveBeenCalled();
      expect(TestBed.inject(Router).url).toBe('/');
    });

    it('remembers the free choices once everything went, not what costs money (AC-4)', async () => {
      const panel = await renderPanel({ features: PAID });
      await chooseChecked(panel);
      await chooseAi(panel);
      clickSend();
      panel.http.expectOne(TOPIC).flush(CREATED);
      await panel.fixture.whenStable();
      await finish(panel);
      expect(localStorage.getItem('kb-chat.preparation-choices')).toContain(
        '"tracks":"none"',
      );
    });
  });

  describe('Nível (KBC-105, T14)', () => {
    it('AC-3: has no "Nível" in a collection without levels, and sends none', async () => {
      const panel = await renderPanel();
      await chooseChecked(panel);
      expect(screen.queryByRole('group', { name: 'Nível' })).toBeNull();
      clickSend();
      const create = panel.http.expectOne(TOPIC);
      expect(create.request.body).not.toHaveProperty('level');
    });

    it('AC-1, AC-2: asks for one of the levels offered, none chosen, and sends it', async () => {
      const panel = await renderPanel({ scales: { hermetismo: QS_CI } });
      await chooseChecked(panel);
      const group = screen.getByRole('group', { name: 'Nível' });
      const radios = within(group).getAllByRole<HTMLInputElement>('radio');
      expect(radios.map((one) => one.value)).toEqual(['qs', 'ci']);
      expect(radios.some((one) => one.checked)).toBe(false);

      clickSend();
      await panel.fixture.whenStable();
      expect(within(group).getByRole('alert').textContent).toContain(
        'Escolha o nível deste áudio.',
      );
      panel.http.expectNone({ method: 'POST', url: TOPIC });

      fireEvent.click(within(group).getByRole('radio', { name: 'CI' }));
      await panel.fixture.whenStable();
      clickSend();
      const create = panel.http.expectOne(TOPIC);
      expect(create.request.body).toMatchObject({ level: 'ci' });
    });

    it('empties the choice when the collection has another scale', async () => {
      const panel = await renderPanel({
        scales: { hermetismo: QS_CI, alquimia: [{ id: 'a1', code: 'A1' }] },
      });
      fireEvent.click(screen.getByRole('radio', { name: 'CI' }));
      await panel.fixture.whenStable();
      fireEvent.change(screen.getByLabelText('Acervo'), {
        target: { value: 'alquimia' },
      });
      await panel.fixture.whenStable();
      const radio = screen.getByRole<HTMLInputElement>('radio', { name: 'A1' });
      expect(radio.checked).toBe(false);
    });

    it('AC-7: a file kept at a level the person does not see is named nowhere', async () => {
      const panel = await renderPanel({ scales: { hermetismo: QS_CI } });
      await chooseChecked(panel, audio(), { verdict: 'duplicate-hidden' });
      expect(
        screen.getByText(
          'Este arquivo já está no acervo, num nível que você não vê. Fale com um master.',
        ),
      ).toBeTruthy();
      expect(screen.queryByRole('link')).toBeNull();
      expect(screen.queryByRole('textbox', { name: 'Título' })).toBeNull();
    });

    it('AC-7: the same refusal on creating the item says the same, with no link', async () => {
      const panel = await renderPanel({ scales: { hermetismo: QS_CI } });
      await chooseChecked(panel);
      fireEvent.click(screen.getByRole('radio', { name: 'QS' }));
      await panel.fixture.whenStable();
      clickSend();
      panel.http.expectOne(TOPIC).flush(
        {
          error: {
            code: 'MEDIA_DUPLICATE',
            message: 'This file is already here',
            details: { hidden: true },
          },
        },
        { status: 409, statusText: 'Conflict' },
      );
      await panel.fixture.whenStable();
      expect(
        screen.getByText(/num nível que você não vê\. Fale com um master\./),
      ).toBeTruthy();
      expect(screen.queryByRole('link')).toBeNull();
    });
  });

  describe('a click while the levels load (review round 1)', () => {
    const ALQUIMIA = '/api/v1/topics/alquimia/media';

    /** The file chosen for "Alquimia", whose levels are still on their way. */
    async function sendWhileLoading() {
      const held = holdingLevels('alquimia');
      const panel = await renderPanel({ before: [held.interceptor] });
      fireEvent.change(screen.getByLabelText('Acervo'), {
        target: { value: 'alquimia' },
      });
      choose(panel.container, audio());
      await vi.waitFor(() =>
        panel.http.expectOne(`${ALQUIMIA}/check`).flush({ verdict: 'new' }),
      );
      const send = await vi.waitFor(() =>
        screen.getByRole('button', { name: 'Enviar' }),
      );
      fireEvent.click(send);
      return { ...panel, held };
    }

    it('waits for the levels, says so on the button, then sends by itself', async () => {
      const { http, held } = await sendWhileLoading();

      const button = await vi.waitFor(() =>
        screen.getByRole('button', { name: 'Carregando níveis…' }),
      );
      expect(button.getAttribute('aria-busy')).toBe('true');
      http.expectNone({ method: 'POST', url: ALQUIMIA });

      held.release([]);
      await vi.waitFor(() => {
        const create = http.expectOne({ method: 'POST', url: ALQUIMIA });
        expect(create.request.body).not.toHaveProperty('level');
      });
    });

    it('asks for the level when the levels come with a scale, sending nothing', async () => {
      const { http, held } = await sendWhileLoading();

      held.release(QS_CI);
      await vi.waitFor(() =>
        expect(screen.getByRole('alert').textContent).toContain(
          'Escolha o nível deste áudio.',
        ),
      );
      http.expectNone({ method: 'POST', url: ALQUIMIA });
      expect(screen.getByRole('button', { name: 'Enviar' })).toBeTruthy();
    });
  });

  it('keeps the level chosen between sub-collections of one scale (T14)', async () => {
    const panel = await renderPanel({
      scales: { hermetismo: QS_CI },
      topics: [
        ...TOPICS,
        aTopic({
          slug: 'hermetismo/aulas',
          title: 'Aulas',
          parent: 'hermetismo',
        }),
      ],
    });
    fireEvent.click(screen.getByRole('radio', { name: 'CI' }));
    await panel.fixture.whenStable();
    fireEvent.change(screen.getByLabelText('Acervo'), {
      target: { value: 'hermetismo/aulas' },
    });
    await panel.fixture.whenStable();

    expect(
      screen.getByRole<HTMLInputElement>('radio', { name: 'CI' }).checked,
    ).toBe(true);
  });

  it('offers "Tentar de novo" when the levels fail, and does not hold the send', async () => {
    let calls = 0;
    const failing: HttpInterceptorFn = (request, next) => {
      if (!request.url.endsWith('/media/levels') || calls++ > 0)
        return next(request);
      return throwError(
        () => new HttpErrorResponse({ status: 503, url: request.url }),
      );
    };
    const panel = await renderPanel({ before: [failing] });
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar os níveis.',
    );
    await chooseChecked(panel);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    // Unknown, the API decides (BR-1): the file goes.
    panel.http.expectOne(TOPIC);

    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await panel.fixture.whenStable();
    expect(screen.queryByText('Não consegui carregar os níveis.')).toBeNull();
  });

  it('AC-3: shows no "Carregando níveis…" for a collection with no scale before it', async () => {
    const held = holdingLevels('alquimia');
    await renderPanel({ before: [held.interceptor] });
    fireEvent.change(screen.getByLabelText('Acervo'), {
      target: { value: 'alquimia' },
    });
    await Promise.resolve();

    expect(screen.queryByText('Carregando níveis…')).toBeNull();
    expect(screen.queryByRole('group', { name: 'Nível' })).toBeNull();
    held.release([]);
  });
});
