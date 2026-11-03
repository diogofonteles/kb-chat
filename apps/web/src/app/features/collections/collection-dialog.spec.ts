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
/** A vault topic inside a folder that only groups topics: never a parent. */
const GROUPED = aTopic({ slug: 'harness/goclaw', title: 'Goclaw' });

async function renderDialog() {
  const saved = vi.fn();
  const view = await render(CollectionDialog, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
    inputs: { topics: [UDV, PALAVRA, CLOSED, GROUPED] },
    on: { saved },
  });
  const http = TestBed.inject(HttpTestingController);
  return { ...view, saved, http, dialog: view.fixture.componentInstance };
}

const nameBox = () => screen.getByRole('textbox', { name: 'Nome' });

/** Answers the authors the edit dialog asks for (KBC-049), then lets it settle. */
async function openedWithAuthors(
  fixture: { whenStable(): Promise<unknown> },
  http: HttpTestingController,
  items: { slug: string; name: string; main: boolean }[],
) {
  TestBed.tick();
  http
    .expectOne({ method: 'GET', url: '/api/v1/topics/udv/authors' })
    .flush({ items });
  await fixture.whenStable();
}

const mainAuthorSelect = () =>
  screen.getByRole<HTMLSelectElement>('combobox', { name: 'Autor principal' });

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
    await openedWithAuthors(fixture, http, []);
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

  it("KBC-049 FR-2: chooses the main author among the collection's, and sends it", async () => {
    const { dialog, fixture, http, saved } = await renderDialog();
    dialog.openEdit(UDV);
    await openedWithAuthors(fixture, http, [
      { slug: 'ana', name: 'Ana', main: false },
      { slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: false },
    ]);
    const select = mainAuthorSelect();
    expect(
      [...select.options].map((option) => option.textContent?.trim()),
    ).toEqual(['Nenhum', 'Ana', 'Mestre Gabriel']);
    expect(select.value).toBe('');

    fireEvent.change(select, { target: { value: 'mestre-gabriel' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

    const request = http.expectOne({
      method: 'PATCH',
      url: '/api/v1/topics/udv',
    });
    expect(request.request.body).toEqual({
      title: 'UDV',
      description: '',
      mainAuthor: 'mestre-gabriel',
    });
    const updated = {
      ...UDV,
      mainAuthor: { slug: 'mestre-gabriel', name: 'Mestre Gabriel' },
    };
    request.flush(updated);
    expect(saved).toHaveBeenCalledWith(updated);
  });

  it('KBC-049: clears the main author with "Nenhum" and says when there are no authors yet', async () => {
    const { dialog, fixture, http } = await renderDialog();
    dialog.openEdit({ ...UDV, mainAuthor: { slug: 'ana', name: 'Ana' } });
    await openedWithAuthors(fixture, http, [
      { slug: 'ana', name: 'Ana', main: true },
    ]);
    expect(mainAuthorSelect().value).toBe('ana');
    fireEvent.change(mainAuthorSelect(), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    expect(
      http.expectOne({ method: 'PATCH', url: '/api/v1/topics/udv' }).request
        .body,
    ).toMatchObject({ mainAuthor: null });
  });

  it('KBC-049 BR-1: a sub-collection has no main author of its own to choose', async () => {
    const { dialog, fixture, http } = await renderDialog();
    dialog.openEdit(PALAVRA);
    await fixture.whenStable();
    expect(
      screen.queryByRole('combobox', { name: 'Autor principal' }),
    ).toBeNull();
    http.expectNone({ method: 'GET' });
  });

  it('KBC-049 review: keeps the current main author while the list loads, never a false "Nenhum"', async () => {
    const { dialog } = await renderDialog();
    dialog.openEdit({ ...UDV, mainAuthor: { slug: 'ana', name: 'Ana' } });
    TestBed.tick();

    const select = mainAuthorSelect();
    expect(select.disabled).toBe(true);
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe('Ana');
    expect(screen.getByText('Carregando os autores…')).toBeTruthy();
  });

  it('KBC-049 review: says the list failed and tries again', async () => {
    const { dialog, fixture, http } = await renderDialog();
    dialog.openEdit({ ...UDV, mainAuthor: { slug: 'ana', name: 'Ana' } });
    TestBed.tick();
    http
      .expectOne('/api/v1/topics/udv/authors')
      .flush(null, { status: 503, statusText: 'Unavailable' });
    await fixture.whenStable();

    expect(screen.getByRole('alert').textContent).toContain(
      'Não foi possível carregar os autores.',
    );
    expect(mainAuthorSelect().selectedOptions[0]?.textContent?.trim()).toBe(
      'Ana',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    await openedWithAuthors(fixture, http, [
      { slug: 'ana', name: 'Ana', main: true },
    ]);
    expect(mainAuthorSelect().disabled).toBe(false);
    expect(mainAuthorSelect().value).toBe('ana');
  });

  it('KBC-049: says a collection has no authors yet', async () => {
    const { dialog, fixture, http } = await renderDialog();
    dialog.openEdit(UDV);
    await openedWithAuthors(fixture, http, []);
    expect(screen.getByText(/ainda não tem autores/)).toBeTruthy();
  });

  it('Enter in the name creates it, and the button says it is saving meanwhile', async () => {
    const { dialog, fixture, http } = await renderDialog();
    dialog.openNew();
    await fixture.whenStable();
    fireEvent.input(nameBox(), { target: { value: 'Hinos' } });
    fireEvent.submit(nameBox().closest('form') as HTMLFormElement);
    await fixture.whenStable();
    const busy = screen.getByRole('button', { name: 'Salvando…' });
    expect(busy.hasAttribute('disabled')).toBe(true);
    http
      .expectOne({ method: 'POST', url: '/api/v1/topics' })
      .flush(aTopic({ slug: 'hinos', title: 'Hinos' }));
  });
});
