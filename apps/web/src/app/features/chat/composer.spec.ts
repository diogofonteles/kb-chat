import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { BusyWork } from '@core/app-version/busy-work.js';
import {
  DRAFT_OWNER,
  KEPT_DRAFT_TTL_MS,
} from '@core/app-version/kept-draft.js';
import { COMPOSER_DRAFT_KEY, Composer } from './composer.js';

describe('Composer and a new version of the app (KBC-123 AC-2)', () => {
  beforeEach(() => sessionStorage.clear());
  afterEach(() => {
    vi.restoreAllMocks();
    sessionStorage.clear();
  });

  async function renderComposer(owner: string | null = 'owner-a') {
    const submitted = vi.fn();
    const view = await render(Composer, {
      providers: [
        provideZonelessChangeDetection(),
        { provide: DRAFT_OWNER, useValue: () => owner },
      ],
      inputs: { mode: 'all' },
      on: { submitted },
    });
    return { view, submitted, work: TestBed.inject(BusyWork) };
  }

  const question = () => screen.getByLabelText('Sua pergunta');
  const typeQuestion = (text: string) =>
    fireEvent.input(question(), { target: { value: text } });

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

  it('writes the unsent question down before a reload, and the same person sees it once', async () => {
    const { view, work } = await renderComposer();
    typeQuestion('o princípio da polaridade');
    work.saveDrafts();
    expect(sessionStorage.getItem(COMPOSER_DRAFT_KEY)).not.toContain(
      'owner@example.com',
    );
    view.fixture.destroy();
    TestBed.resetTestingModule();

    await renderComposer();
    expect(question()).toHaveProperty('value', 'o princípio da polaridade');
    expect(sessionStorage.getItem(COMPOSER_DRAFT_KEY)).toBeNull();
  });

  it('never shows the draft to someone else signing in on the same tab (review R2-5)', async () => {
    const { view, work } = await renderComposer('owner-a');
    typeQuestion('pergunta de quem saiu');
    work.saveDrafts();
    view.fixture.destroy();
    TestBed.resetTestingModule();

    await renderComposer('owner-b');
    expect(question()).toHaveProperty('value', '');
    expect(sessionStorage.getItem(COMPOSER_DRAFT_KEY)).toBeNull();
  });

  it('drops a draft older than ten minutes (review R2-5)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { view, work } = await renderComposer();
    typeQuestion('pergunta antiga');
    work.saveDrafts();
    view.fixture.destroy();
    TestBed.resetTestingModule();
    vi.setSystemTime(Date.now() + KEPT_DRAFT_TTL_MS + 1);

    await renderComposer();
    expect(question()).toHaveProperty('value', '');
    vi.useRealTimers();
  });

  it('keeps nothing for an empty box or with nobody signed in, and a blocked storage only loses the draft', async () => {
    const { work } = await renderComposer();
    sessionStorage.setItem(COMPOSER_DRAFT_KEY, 'velho');
    work.saveDrafts();
    expect(sessionStorage.getItem(COMPOSER_DRAFT_KEY)).toBeNull();
    TestBed.resetTestingModule();

    const signedOut = await renderComposer(null);
    typeQuestion('sem sessão');
    signedOut.work.saveDrafts();
    expect(sessionStorage.getItem(COMPOSER_DRAFT_KEY)).toBeNull();

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    expect(() => signedOut.work.saveDrafts()).not.toThrow();
  });
});
