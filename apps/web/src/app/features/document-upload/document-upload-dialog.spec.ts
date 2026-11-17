import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { DocumentUpload } from '@kb-chat/contracts';
import { TUS_UPLOAD } from '@core/media/tus-upload.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/angular';
import { FakeTus } from '../../testing/fake-tus.js';
import { DocumentUploadDialog } from './document-upload-dialog.js';

const LEVELS = '/api/v1/topics/hermetismo/media/levels';
const DOCUMENTS = '/api/v1/topics/hermetismo/documents';

const anUpload = (fields: Partial<DocumentUpload> = {}): DocumentUpload => ({
  id: '11111111-1111-4111-8111-111111111111',
  topic: 'hermetismo',
  kind: 'file',
  name: 'Caibalion.pdf',
  state: 'receiving',
  failure: null,
  detail: null,
  document: null,
  mediaId: null,
  bytes: 11,
  received: 0,
  uploadUrl:
    '/api/v1/document-uploads/11111111-1111-4111-8111-111111111111/upload',
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z',
  ...fields,
});

async function renderDialog(levels: { id: string; code: string }[] = []) {
  const tus = new FakeTus();
  const opened = vi.fn();
  const view = await render(DocumentUploadDialog, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: TUS_UPLOAD, useValue: tus.factory },
    ],
    inputs: { topic: 'hermetismo', topicTitle: 'Hermetismo' },
    on: { documentOpened: opened },
  });
  const http = TestBed.inject(HttpTestingController);
  // Nothing is read while the dialog is closed.
  http.expectNone(LEVELS);
  view.fixture.componentInstance.open();
  await waitFor(() =>
    http.expectOne(LEVELS).flush({ collection: 'hermetismo', levels }),
  );
  await view.fixture.whenStable();
  return { ...view, http, tus, opened };
}

const sendButton = () =>
  screen
    .getAllByRole('button', { name: 'Enviar' })
    .find(
      (one) => one.getAttribute('uibutton') === 'primary',
    ) as HTMLButtonElement;

function chooseFile(name = 'Caibalion.pdf', content = '%PDF-1.4 x') {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  const file = new File([content], name, { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  fireEvent.change(input);
  return file;
}

describe('DocumentUploadDialog (KBC-149)', () => {
  it('hashes a file, announces it and sends it by tus, then says where to follow it', async () => {
    const { http, tus, fixture } = await renderDialog();
    expect(screen.getByText('Hermetismo')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    chooseFile();
    await fixture.whenStable();

    fireEvent.click(sendButton());
    const created = await waitFor(() => http.expectOne(DOCUMENTS));
    expect(created.request.body).toMatchObject({
      kind: 'file',
      name: 'Caibalion.pdf',
      bytes: 10,
    });
    expect(created.request.body.sha256).toMatch(/^[0-9a-f]{64}$/);
    created.flush(
      { outcome: 'created', upload: anUpload() },
      { status: 201, statusText: 'Created' },
    );
    await fixture.whenStable();
    expect(tus.last.options.uploadUrl).toBe(anUpload().uploadUrl);
    tus.last.progress(5);
    await fixture.whenStable();
    expect(screen.getByText('Enviando…')).toBeTruthy();
    tus.last.succeed();
    await fixture.whenStable();

    expect(screen.getByText('Recebido')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Fila de processamento' })
        .getAttribute('href'),
    ).toBe('/fila');
    // Nothing more to send: a second press does not send again (PD-02).
    expect(sendButton()).toBeUndefined();
  });

  it('AC-3: a document already in the collection is said, with "Abrir documento"', async () => {
    const { http, opened, fixture } = await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await fixture.whenStable();
    fireEvent.input(screen.getByLabelText('Endereço'), {
      target: { value: 'https://example.org/artigo' },
    });
    await fixture.whenStable();
    fireEvent.click(sendButton());
    const request = http.expectOne(DOCUMENTS);
    expect(request.request.body).toEqual({
      kind: 'url',
      url: 'https://example.org/artigo',
    });
    const document = { id: 'raw/articles/artigo.md', title: 'O Artigo' };
    request.flush({ outcome: 'duplicate', document, upload: null });
    await fixture.whenStable();

    expect(screen.getByText('Este documento já está no acervo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Abrir documento' }));
    expect(opened).toHaveBeenCalledWith({ topic: 'hermetismo', ...document });
  });

  it('a link not on the web, and a file that is not a document, are refused here', async () => {
    const { fixture } = await renderDialog();
    chooseFile('aula.mp3');
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Áudio e vídeo vão pela Biblioteca',
    );
    expect(sendButton().disabled).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await fixture.whenStable();
    fireEvent.input(screen.getByLabelText('Endereço'), {
      target: { value: 'ftp://x' },
    });
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain('https://');
    expect(sendButton().disabled).toBe(true);
  });

  it('in a collection with levels, the level is chosen before sending', async () => {
    const { http, fixture } = await renderDialog([
      { id: 'qs', code: 'QS' },
      { id: 'ci', code: 'CI' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await fixture.whenStable();
    fireEvent.input(screen.getByLabelText('Endereço'), {
      target: { value: 'https://youtu.be/abc' },
    });
    await fixture.whenStable();
    expect(sendButton().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Nível'), {
      target: { value: 'ci' },
    });
    await fixture.whenStable();
    fireEvent.click(sendButton());
    const request = http.expectOne(DOCUMENTS);
    expect(request.request.body).toEqual({
      kind: 'url',
      url: 'https://youtu.be/abc',
      level: 'ci',
    });
    request.flush(
      {
        outcome: 'created',
        upload: anUpload({
          kind: 'youtube',
          state: 'received',
          uploadUrl: null,
        }),
      },
      { status: 201, statusText: 'Created' },
    );
    await fixture.whenStable();
    expect(screen.getByText('Recebido')).toBeTruthy();
  });

  it('a refusal is said in words, and the person can try again', async () => {
    const { http, fixture } = await renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Link' }));
    await fixture.whenStable();
    fireEvent.input(screen.getByLabelText('Endereço'), {
      target: { value: 'https://ex.org' },
    });
    await fixture.whenStable();
    fireEvent.click(sendButton());
    http
      .expectOne(DOCUMENTS)
      .flush(
        { error: { code: 'FORBIDDEN', message: 'x' } },
        { status: 403, statusText: 'Forbidden' },
      );
    await fixture.whenStable();
    expect(screen.getByText('Não consegui enviar')).toBeTruthy();
    expect(sendButton().disabled).toBe(false);
  });
});
