import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { aTopic } from '../../testing/fixtures.js';
import { CollectionDialog } from './collection-dialog.js';

const UDV = aTopic({ slug: 'udv', title: 'UDV', documentCount: 3 });
const PALAVRA = aTopic({
  slug: 'udv/palavra-do-mestre',
  title: 'Palavra do Mestre',
  parent: 'udv',
});
const CLOSED = aTopic({ slug: 'fechado', title: 'Fechado', canOpen: false });

async function renderDialog() {
  const saved = vi.fn();
  const view = await render(CollectionDialog, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
    inputs: { topics: [UDV, PALAVRA, CLOSED] },
    on: { saved },
  });
  const http = TestBed.inject(HttpTestingController);
  return { ...view, saved, http, dialog: view.fixture.componentInstance };
}

const nameBox = () => screen.getByRole('textbox', { name: 'Nome' });

describe('CollectionDialog (KBC-048 FR-6, FR-2)', () => {
  it('shows the address the name becomes and creates it inside the chosen parent', async () => {
    const { dialog, fixture, http, saved } = await renderDialog();
    dialog.openNew();
    await fixture.whenStable();
    fireEvent.input(nameBox(), { target: { value: 'Hinos de Ação' } });
    await fixture.whenStable();
    expect(screen.getByText('hinos-de-acao')).toBeTruthy();
    fireEvent.change(screen.getByRole('combobox', { name: 'Dentro de' }), {
      target: { value: 'udv' },
    });
    await fixture.whenStable();
    expect(screen.getByText('udv/hinos-de-acao')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Criar acervo' }));
    const request = http.expectOne({ method: 'POST', url: '/api/v1/topics' });
    expect(request.request.body).toEqual({
      title: 'Hinos de Ação',
      description: '',
      parent: 'udv',
    });
    const created = aTopic({
      slug: 'udv/hinos-de-acao',
      title: 'Hinos de Ação',
      parent: 'udv',
    });
    request.flush(created);
    expect(saved).toHaveBeenCalledWith(created);
  });

  it('AC-3: offers only top-level collections the person opens as parents', async () => {
    const { dialog, fixture } = await renderDialog();
    dialog.openNew();
    await fixture.whenStable();
    const options = screen
      .getAllByRole('option')
      .map((option) => option.textContent?.trim());
    expect(options).toEqual(['Nenhum (acervo principal)', 'UDV']);
  });

  it('refuses a name with no letter or digit and keeps the focus on it', async () => {
    const { dialog, fixture, http } = await renderDialog();
    dialog.openNew();
    await fixture.whenStable();
    fireEvent.input(nameBox(), { target: { value: '!!!' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar acervo' }));
    await fixture.whenStable();
    expect(screen.getByText(/pelo menos uma letra ou número/)).toBeTruthy();
    expect(nameBox().getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(nameBox());
    http.verify();
  });

  it('AC-7: says the name is taken, and nothing closes', async () => {
    const { dialog, fixture, http, saved } = await renderDialog();
    dialog.openNew();
    await fixture.whenStable();
    fireEvent.input(nameBox(), { target: { value: 'Udv' } });
    fireEvent.click(screen.getByRole('button', { name: 'Criar acervo' }));
    http
      .expectOne('/api/v1/topics')
      .flush(
        { error: { code: 'TOPIC_EXISTS', message: 'exists' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Já existe um acervo com esse nome.',
    );
    expect(saved).not.toHaveBeenCalled();
  });

  it('AC-6: editing keeps the address and sends only the names', async () => {
    const { dialog, fixture, http } = await renderDialog();
    dialog.openEdit(UDV);
    await fixture.whenStable();
    expect(screen.getByRole('heading', { name: 'Editar acervo' })).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: 'Dentro de' })).toBeNull();
    expect((nameBox() as HTMLInputElement).value).toBe('UDV');
    fireEvent.input(nameBox(), { target: { value: 'União do Vegetal' } });
    await fixture.whenStable();
    expect(screen.getByText('udv')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    const request = http.expectOne({
      method: 'PATCH',
      url: '/api/v1/topics/udv',
    });
    expect(request.request.body).toEqual({
      title: 'União do Vegetal',
      description: '',
    });
  });
});
