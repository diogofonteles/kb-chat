import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { BusyWork } from '@core/app-version/busy-work.js';
import { COMPOSER_DRAFT_KEY, Composer } from './composer.js';

describe('Composer and a new version of the app (KBC-123 AC-2)', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => sessionStorage.clear());

  async function renderComposer() {
    const submitted = vi.fn();
    const view = await render(Composer, {
      providers: [provideZonelessChangeDetection()],
      inputs: { mode: 'all' },
      on: { submitted },
    });
    return { view, submitted, work: TestBed.inject(BusyWork) };
  }

  it('holds a reload while a question is typed and not sent', async () => {
    const { view, submitted, work } = await renderComposer();
    const field = screen.getByLabelText('Sua pergunta');
    fireEvent.input(field, { target: { value: '   ' } });
    expect(work.busy()).toBe(false);
    fireEvent.input(field, { target: { value: 'o que é o caibalion?' } });
    expect(work.busy()).toBe(true);
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    expect(submitted).toHaveBeenCalledWith('o que é o caibalion?');
    expect(work.busy()).toBe(false);
  });

  it('lets go of the hold when the question box goes away', async () => {
    const { view, work } = await renderComposer();
    fireEvent.input(screen.getByLabelText('Sua pergunta'), {
      target: { value: 'rascunho' },
    });
    expect(work.busy()).toBe(true);
    view.fixture.destroy();
    expect(work.busy()).toBe(false);
  });

  it('writes the unsent question down before a reload, and the new app shows it once', async () => {
    const { view, work } = await renderComposer();
    fireEvent.input(screen.getByLabelText('Sua pergunta'), {
      target: { value: 'o princípio da polaridade' },
    });
    work.saveDrafts();
    expect(sessionStorage.getItem(COMPOSER_DRAFT_KEY)).toBe(
      'o princípio da polaridade',
    );
    view.fixture.destroy();
    TestBed.resetTestingModule();

    await renderComposer();
    expect(screen.getByLabelText('Sua pergunta')).toHaveProperty(
      'value',
      'o princípio da polaridade',
    );
    expect(sessionStorage.getItem(COMPOSER_DRAFT_KEY)).toBeNull();
  });

  it('keeps nothing for an empty box, and a blocked storage only loses the draft', async () => {
    const { work } = await renderComposer();
    sessionStorage.setItem(COMPOSER_DRAFT_KEY, 'velho');
    work.saveDrafts();
    expect(sessionStorage.getItem(COMPOSER_DRAFT_KEY)).toBeNull();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    fireEvent.input(screen.getByLabelText('Sua pergunta'), {
      target: { value: 'texto' },
    });
    expect(() => work.saveDrafts()).not.toThrow();
  });
});
