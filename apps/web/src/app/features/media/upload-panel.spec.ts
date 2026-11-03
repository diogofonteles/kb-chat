import {
  HttpBackend,
  HttpEventType,
  provideHttpClient,
} from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { MEDIA_UPLOAD_BACKEND } from '@core/media/media-api.js';
import { aTopic } from '../../testing/fixtures.js';
import { aMediaItem } from '../../testing/media-fixtures.js';
import { UploadPanel } from './upload-panel.js';

const CREATED = aMediaItem({
  status: 'uploading',
  durationMs: null,
  bytes: null,
});

async function renderPanel() {
  const uploaded = vi.fn();
  const closed = vi.fn();
  const view = await render(UploadPanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      {
        provide: MEDIA_UPLOAD_BACKEND,
        useFactory: () => TestBed.inject(HttpBackend),
      },
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
  return { ...view, uploaded, closed, http };
}

function choose(container: HTMLElement, file: File) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]');
  if (!input) throw new Error('no file input');
  Object.defineProperty(input, 'files', {
    value: { item: () => file, length: 1 },
    configurable: true,
  });
  fireEvent.change(input);
}

const audio = (name = 'Palestra_de_1998.mp3', size = 3) =>
  new File([new Uint8Array(size)], name, { type: 'audio/mpeg' });

describe('UploadPanel (T14, KBC-034)', () => {
  it('opens as a dialog that says the rule before the choice (MA-20)', async () => {
    await renderPanel();
    expect(screen.getByRole('dialog', { name: 'Enviar áudio' })).toBeTruthy();
    expect(
      screen.getByText('mp3, m4a, wav, flac, ogg ou opus, até 500 MB'),
    ).toBeTruthy();
  });

  it('suggests the title from the file and refuses a file that is not audio (AC-8)', async () => {
    const { container, fixture } = await renderPanel();
    choose(container, audio());
    await fixture.whenStable();
    expect(
      screen.getByRole<HTMLInputElement>('textbox', { name: 'Título' }).value,
    ).toBe('Palestra de 1998');
    choose(container, audio('apostila.pdf'));
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Este arquivo não é um áudio aceito. Envie mp3, m4a, wav, flac, ogg ou opus.',
    );
  });

  it('asks for a file before sending, sending nothing', async () => {
    const { fixture, http } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await fixture.whenStable();
    expect(screen.getByText('Escolha um arquivo de áudio.')).toBeTruthy();
    http.expectNone('/api/v1/topics/hermetismo/media');
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
    const { container, fixture, http, uploaded } = await renderPanel();
    choose(container, audio());
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
    const create = http.expectOne('/api/v1/topics/hermetismo/media');
    expect(create.request.body).toEqual({
      title: 'Palestra de 1998',
      author: 'mestre-gabriel',
      fileName: 'Palestra_de_1998.mp3',
      bytes: 3,
    });
    create.flush(CREATED);
    const put = http.expectOne(`/api/v1/media/${CREATED.id}/file`);
    put.event({ type: HttpEventType.UploadProgress, loaded: 1, total: 3 });
    await fixture.whenStable();
    expect(screen.getByRole('progressbar').getAttribute('value')).toBe('33');
    expect(screen.getByText(/Enviando… 0 de 0 MB · 33%/)).toBeTruthy();
    put.flush({ ...CREATED, status: 'queued' });
    expect(uploaded).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'queued' }),
    );
  });

  it('keeps the fields when the connection breaks and sends again to the same item (MA-26)', async () => {
    const { container, fixture, http, uploaded } = await renderPanel();
    choose(container, audio());
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    http.expectOne('/api/v1/topics/hermetismo/media').flush(CREATED);
    http
      .expectOne(`/api/v1/media/${CREATED.id}/file`)
      .error(new ProgressEvent('error'), { status: 0 });
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'O envio parou: verifique a conexão e tente de novo.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    http.expectNone('/api/v1/topics/hermetismo/media');
    http
      .expectOne(`/api/v1/media/${CREATED.id}/file`)
      .flush({ ...CREATED, status: 'queued' });
    expect(uploaded).toHaveBeenCalledTimes(1);
  });

  it('explains a file the server refused', async () => {
    const { container, fixture, http } = await renderPanel();
    choose(container, audio());
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    http
      .expectOne('/api/v1/topics/hermetismo/media')
      .flush(
        { error: { code: 'VALIDATION_FAILED', message: 'x' } },
        { status: 400, statusText: 'Bad Request' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Envie um áudio de até 500 MB (mp3, m4a, wav, flac, ogg ou opus).',
    );
  });

  it('cancels a running upload and removes the half-sent item', async () => {
    const { container, fixture, http } = await renderPanel();
    choose(container, audio());
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    http.expectOne('/api/v1/topics/hermetismo/media').flush(CREATED);
    const put = http.expectOne(`/api/v1/media/${CREATED.id}/file`);
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar envio' }));
    expect(put.cancelled).toBe(true);
    http
      .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
      .flush(null);
  });

  it('warns before leaving the page only while sending', async () => {
    const { container, http, fixture } = await renderPanel();
    const idle = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(idle);
    expect(idle.defaultPrevented).toBe(false);
    choose(container, audio());
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    http.expectOne('/api/v1/topics/hermetismo/media').flush(CREATED);
    http.expectOne(`/api/v1/media/${CREATED.id}/file`);
    await fixture.whenStable();
    const sending = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(sending);
    expect(sending.defaultPrevented).toBe(true);
  });

  it('accepts a dropped file and closes with "Cancelar"', async () => {
    const { container, fixture, closed } = await renderPanel();
    const zone = container.querySelector('.drop');
    if (!zone) throw new Error('no drop zone');
    fireEvent.dragOver(zone);
    await fixture.whenStable();
    expect(zone.classList.contains('dragging')).toBe(true);
    fireEvent.drop(zone, {
      dataTransfer: { files: { item: () => audio('aula.flac') } },
    });
    await fixture.whenStable();
    expect(screen.getByText('aula.flac')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  /** Fills the panel and sends; returns the create request. */
  function sendAudio(
    context: Awaited<ReturnType<typeof renderPanel>>,
    file = audio(),
  ) {
    choose(context.container, file);
    fireEvent.click(
      screen.getByRole('button', { name: /^(Enviar|Tentar de novo)$/ }),
    );
  }

  it('removes the created item when Escape closes the panel mid-upload', async () => {
    const context = await renderPanel();
    sendAudio(context);
    context.http.expectOne('/api/v1/topics/hermetismo/media').flush(CREATED);
    const put = context.http.expectOne(`/api/v1/media/${CREATED.id}/file`);
    screen.getByRole('dialog').dispatchEvent(new Event('close'));
    expect(put.cancelled).toBe(true);
    context.http
      .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
      .flush(null);
    expect(context.closed).toHaveBeenCalledTimes(1);
  });

  it('removes the created item when the person gives up after a failure', async () => {
    const context = await renderPanel();
    sendAudio(context);
    context.http.expectOne('/api/v1/topics/hermetismo/media').flush(CREATED);
    context.http
      .expectOne(`/api/v1/media/${CREATED.id}/file`)
      .error(new ProgressEvent('error'), { status: 0 });
    await context.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    context.http
      .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
      .flush(null);
  });

  it('creates a new item when the file changed after a failure, removing the old one', async () => {
    const context = await renderPanel();
    sendAudio(context);
    context.http.expectOne('/api/v1/topics/hermetismo/media').flush(CREATED);
    context.http
      .expectOne(`/api/v1/media/${CREATED.id}/file`)
      .error(new ProgressEvent('error'), { status: 0 });
    await context.fixture.whenStable();
    sendAudio(context, audio('Outra_aula.mp3', 5));
    context.http
      .expectOne({ method: 'DELETE', url: `/api/v1/media/${CREATED.id}` })
      .flush(null);
    const again = context.http.expectOne('/api/v1/topics/hermetismo/media');
    expect(again.request.body).toMatchObject({
      fileName: 'Outra_aula.mp3',
      bytes: 5,
      title: 'Outra aula',
    });
    again.flush({ ...CREATED, id: '22222222-2222-4222-8222-222222222222' });
    context.http
      .expectOne('/api/v1/media/22222222-2222-4222-8222-222222222222/file')
      .flush({ ...CREATED, status: 'queued' });
    expect(context.uploaded).toHaveBeenCalledTimes(1);
  });

  it("sends nothing while the author's name breaks the API's rule (KBC-049 QA)", async () => {
    const { container, fixture, http } = await renderPanel();
    choose(container, audio());
    const field = screen.getByRole('combobox', { name: 'Autor' });
    fireEvent.input(field, { target: { value: 'Mestre "Gabriel"' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await fixture.whenStable();

    http.expectNone({ method: 'POST' });
    expect(field.getAttribute('aria-invalid')).toBe('true');
  });

  it('tells a refused author as an author problem, never as the file (KBC-049 QA)', async () => {
    const { container, fixture, http } = await renderPanel();
    choose(container, audio());
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
    expect(alert).not.toContain('500 MB');
    http.expectNone('/api/v1/topics/hermetismo/media');
  });

  it('tells an author the collection lost as an author problem too', async () => {
    const { container, fixture, http } = await renderPanel();
    choose(container, audio());
    fireEvent.input(screen.getByRole('combobox', { name: 'Autor' }), {
      target: { value: 'Mestre Gabriel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    http
      .expectOne({ method: 'POST', url: '/api/v1/topics/hermetismo/authors' })
      .flush({ slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: false });
    http.expectOne('/api/v1/topics/hermetismo/media').flush(
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
    const { container, http, fixture } = await renderPanel();
    choose(container, audio());
    const title = screen.getByRole('textbox', { name: 'Título' });
    fireEvent.input(title, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await fixture.whenStable();
    expect(screen.getByText('Dê um título ao áudio.')).toBeTruthy();
    expect(title.getAttribute('aria-invalid')).toBe('true');
    http.expectNone({ method: 'POST' });
    fireEvent.input(title, { target: { value: '  Aula 3  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    const created = http.expectOne({ method: 'POST' });
    expect(created.request.body).toMatchObject({
      title: 'Aula 3',
      author: null,
    });
    created.flush(CREATED);
  });

  it('keeps a title the person typed when another file is chosen', async () => {
    const { container, fixture } = await renderPanel();
    choose(container, audio());
    const title = screen.getByRole<HTMLInputElement>('textbox', {
      name: 'Título',
    });
    fireEvent.input(title, { target: { value: 'Meu título' } });
    choose(container, audio('Outra.mp3'));
    await fixture.whenStable();
    expect(title.value).toBe('Meu título');
  });

  it('sends to the collection chosen in "Acervo"', async () => {
    const context = await renderPanel();
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Acervo',
    });
    expect(select.value).toBe('hermetismo');
    fireEvent.change(select, { target: { value: 'alquimia' } });
    sendAudio(context);
    context.http.expectOne('/api/v1/topics/alquimia/media').flush(CREATED);
    context.http
      .expectOne(`/api/v1/media/${CREATED.id}/file`)
      .flush({ ...CREATED, status: 'queued' });
  });
});
