import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { DocumentRemoval } from '@kb-chat/contracts';
import { RemovedDocuments } from './removed-documents.js';

const URL = '/api/v1/document-removals';
const ID = '11111111-1111-4111-8111-111111111111';
const removal = (fields: Partial<DocumentRemoval> = {}): DocumentRemoval => ({
  id: ID,
  topic: 'hermetismo',
  collection: 'Hermetismo',
  document: { id: 'raw/livro.md', title: 'O Livro' },
  state: 'removed',
  asked: 'removed',
  detail: null,
  by: 'Dono',
  removedAt: '2026-11-25T12:00:00.000Z',
  ...fields,
});

async function shown(items: DocumentRemoval[]) {
  const view = await render(RemovedDocuments, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(URL).flush({ items });
  await view.fixture.whenStable();
  return { ...view, http };
}

describe('RemovedDocuments (KBC-187)', () => {
  it('says there is nothing, and how a document leaves', async () => {
    await shown([]);
    expect(screen.getByText(/Nada removido/)).toBeTruthy();
  });

  it('lists what left, by whom, and brings it back', async () => {
    const { http, fixture } = await shown([removal()]);
    expect(screen.getByText('O Livro')).toBeTruthy();
    expect(screen.getByText(/Hermetismo · Dono/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Trazer de volta O Livro' }),
    );
    http.expectOne({ method: 'POST', url: `${URL}/${ID}/restore` }).flush({
      removal: removal({ state: 'restoring', asked: 'present' }),
    });
    TestBed.tick();
    http
      .expectOne(URL)
      .flush({ items: [removal({ state: 'restoring', asked: 'present' })] });
    await fixture.whenStable();
    expect(screen.getByText('Voltando; espera o Mac')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Trazer de volta O Livro' }),
    ).toBeNull();
    expect(document.activeElement?.textContent).toContain('Nada foi');
  });

  it('says what the Mac has not moved yet, and what it could not', async () => {
    await shown([
      removal({ state: 'removing' }),
      removal({
        id: '22222222-2222-4222-8222-222222222222',
        document: { id: 'raw/outro.md', title: 'Outro' },
        state: 'failed',
        detail: 'kb review: no',
      }),
    ]);
    expect(screen.getByText('Fora; o Mac ainda move o arquivo')).toBeTruthy();
    expect(screen.getByText('kb review: no')).toBeTruthy();
    expect(
      screen.getByText('Fora do app; o Mac não moveu o arquivo'),
    ).toBeTruthy();
    // It failed on the way out: it may be asked again, or given up.
    for (const name of ['Tentar de novo Outro', 'Trazer de volta Outro'])
      expect(screen.getByRole('button', { name })).toBeTruthy();
  });

  it('what failed on the way back is only asked again', async () => {
    await shown([
      removal({ state: 'failed', asked: 'present', detail: 'kb: no' }),
    ]);
    expect(
      screen.getByText('O Mac não conseguiu trazer de volta'),
    ).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Trazer de volta O Livro' }),
    ).toBeNull();
  });

  it('a press on the way keeps the focus, and a reading that fails keeps the list', async () => {
    const { http, fixture } = await shown([removal()]);
    const button = screen.getByRole('button', {
      name: 'Trazer de volta O Livro',
    });
    button.focus();
    fireEvent.click(button);
    TestBed.tick();
    expect(button.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(button);
    http
      .expectOne(`${URL}/${ID}/restore`)
      .flush(
        { error: { code: 'NOT_FOUND', message: 'x' } },
        { status: 500, statusText: 'x' },
      );
    expect(document.activeElement).toBe(button);
    TestBed.tick();
    http.expectOne(URL).flush('x', { status: 503, statusText: 'x' });
    await fixture.whenStable();
    expect(screen.getByText('O Livro')).toBeTruthy();
  });

  it('says when it could not be done, and reads the list again', async () => {
    const { http, fixture } = await shown([removal()]);
    fireEvent.click(
      screen.getByRole('button', { name: 'Trazer de volta O Livro' }),
    );
    http
      .expectOne(`${URL}/${ID}/restore`)
      .flush(
        { error: { code: 'NOT_FOUND', message: 'x' } },
        { status: 404, statusText: 'Not Found' },
      );
    TestBed.tick();
    http.expectOne(URL).flush({ items: [] });
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toBeTruthy();
    expect(screen.getByText(/Nada removido/)).toBeTruthy();
  });
});
