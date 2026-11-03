import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { AuthorCombobox } from './author-combobox.js';

const AUTHORS = {
  items: [
    { slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: true },
    { slug: 'ana-souza', name: 'Ana Souza', main: false },
  ],
};

async function renderField(topic = 'udv/palavra-do-mestre') {
  const changed = vi.fn();
  const view = await render(AuthorCombobox, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
    inputs: { topic },
  });
  // The model's change event, as a parent's [(name)] would get it.
  view.fixture.componentInstance.name.subscribe(changed);
  const field = screen.getByRole<HTMLInputElement>('combobox', {
    name: 'Autor',
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectNone(`/api/v1/topics/${encodeURIComponent(topic)}/authors`);
  fireEvent.focus(field);
  TestBed.tick();
  http
    .expectOne(`/api/v1/topics/${encodeURIComponent(topic)}/authors`)
    .flush(AUTHORS);
  await view.fixture.whenStable();
  return { ...view, field, changed };
}

const options = () =>
  screen.queryAllByRole('option').map((one) => one.textContent?.trim());

describe('AuthorCombobox (KBC-049 FR-3, APG combobox)', () => {
  it("suggests the collection's authors, the main one first with its mark (AC-3)", async () => {
    const { field, fixture } = await renderField();
    expect(field.getAttribute('aria-expanded')).toBe('false');

    fireEvent.keyDown(field, { key: 'ArrowDown' });
    await fixture.whenStable();

    expect(field.getAttribute('aria-expanded')).toBe('true');
    expect(options()).toEqual([
      expect.stringMatching(/✦\s*Autor principal:\s+Mestre Gabriel/),
      'Ana Souza',
    ]);
    expect(field.getAttribute('aria-activedescendant')).toBe(
      screen.getAllByRole('option')[0]?.id,
    );
  });

  it('offers "Cadastrar «nome»" for a new name and takes it with Enter (AC-1)', async () => {
    const { field, fixture, changed } = await renderField();

    fireEvent.input(field, { target: { value: 'Mestre Pedro' } });
    await fixture.whenStable();
    expect(options()).toEqual(['Cadastrar «Mestre Pedro»']);
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'Enter' });
    await fixture.whenStable();

    expect(changed).toHaveBeenLastCalledWith('Mestre Pedro');
    expect(field.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves with the arrows, wrapping, and chooses with the pointer', async () => {
    const { field, fixture, changed } = await renderField();
    fireEvent.keyDown(field, { key: 'ArrowUp' });
    await fixture.whenStable();
    expect(field.getAttribute('aria-activedescendant')).toBe(
      screen.getAllByRole('option')[1]?.id,
    );
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    await fixture.whenStable();
    expect(
      screen.getAllByRole('option')[0]?.getAttribute('aria-selected'),
    ).toBe('true');

    fireEvent.mouseDown(screen.getByRole('option', { name: /Ana Souza/ }));
    await fixture.whenStable();
    expect(changed).toHaveBeenLastCalledWith('Ana Souza');
    expect(field.value).toBe('Ana Souza');
  });

  it('closes only its list on Escape, so the dialog around it stays open', async () => {
    const { field, fixture } = await renderField();
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    await fixture.whenStable();
    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });

    field.dispatchEvent(escape);
    await fixture.whenStable();

    expect(escape.defaultPrevented).toBe(true);
    expect(field.getAttribute('aria-expanded')).toBe('false');
    const again = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    field.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });

  it('says a new name will be registered, and offers the author it is a typo of (MA-27)', async () => {
    const { field, fixture, changed } = await renderField();

    fireEvent.input(field, { target: { value: 'Mestre Gabriell' } });
    await fixture.whenStable();

    expect(
      screen.getByText(
        'Novo autor: «Mestre Gabriell» será cadastrado neste acervo.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Você quis dizer «Mestre Gabriel»?')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Usar «Mestre Gabriel»' }),
    );
    await fixture.whenStable();
    expect(changed).toHaveBeenLastCalledWith('Mestre Gabriel');
    expect(screen.queryByText(/Novo autor/)).toBeNull();
  });
});
