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
import { fireEvent, render, screen } from '@testing-library/angular';
import type { MediaItem } from '@kb-chat/contracts';
import { throwError } from 'rxjs';
import { aMediaItem } from '../../testing/media-fixtures.js';
import { aTopic } from '../../testing/fixtures.js';
import {
  QS_CI,
  answeringLevels,
  holdingLevels,
} from '../../testing/level-fixtures.js';
import { EditMediaDialog, type MediaEdited } from './edit-media-dialog.js';

const ITEM = aMediaItem();
const URL = `/api/v1/media/${ITEM.id}`;
const AUTHORS = '/api/v1/topics/udv/authors';

async function open(
  item: MediaItem = ITEM,
  scales: Parameters<typeof answeringLevels>[0] = {},
  before: HttpInterceptorFn[] = [],
) {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
  const saved = vi.fn<(edit: MediaEdited) => void>();
  const closed = vi.fn();
  const view = await render(EditMediaDialog, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([...before, answeringLevels(scales)])),
      provideHttpClientTesting(),
    ],
    inputs: {
      item,
      topics: [
        aTopic({ slug: 'hermetismo', title: 'Hermetismo' }),
        aTopic({ slug: 'udv', title: 'UDV' }),
        aTopic({ slug: 'fechado', title: 'Fechado', canOpen: false }),
      ],
    },
    on: { saved, closed },
  });
  await view.fixture.whenStable();
  return {
    ...view,
    saved,
    closed,
    http: TestBed.inject(HttpTestingController),
  };
}

const typeTitle = (text: string) =>
  fireEvent.input(screen.getByLabelText('Título'), {
    target: { value: text },
  });

const chooseTopic = (slug: string) =>
  fireEvent.change(screen.getByLabelText('Acervo'), {
    target: { value: slug },
  });

const save = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));

describe('EditMediaDialog (KBC-050)', () => {
  it('opens filled in, with the focus on the title', async () => {
    await open();
    const title = screen.getByLabelText<HTMLInputElement>('Título');
    expect(title.value).toBe('Palestra de 1998');
    expect(screen.getByLabelText<HTMLSelectElement>('Acervo').value).toBe(
      'hermetismo',
    );
    expect(screen.getByLabelText<HTMLInputElement>('Autor').value).toBe(
      'Mestre Laércio',
    );
    expect(document.activeElement).toBe(title);
  });

  it('AC-4: offers only the collections the person opens', async () => {
    await open();
    expect(screen.queryByRole('option', { name: /Fechado/ })).toBeNull();
    expect(screen.getByRole('option', { name: 'UDV' })).toBeTruthy();
  });

  it('AC-1: sends only the new title, closes and tells the page', async () => {
    const { http, saved, fixture } = await open();
    typeTitle('  A conselheira do rei ');
    save();
    const request = http.expectOne(URL);
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ title: 'A conselheira do rei' });
    const answer = aMediaItem({ title: 'A conselheira do rei' });
    request.flush(answer);
    await fixture.whenStable();
    expect(saved).toHaveBeenCalledWith({
      before: ITEM,
      after: expect.objectContaining(answer),
    });
    http.verify();
  });

  it('AC-5: a blank title is said at the field and nothing is sent', async () => {
    const { http, saved, fixture } = await open();
    typeTitle('   ');
    save();
    await fixture.whenStable();
    expect(screen.getByText(/Dê um título ao áudio/)).toBeTruthy();
    expect(screen.getByLabelText('Título').getAttribute('aria-invalid')).toBe(
      'true',
    );
    expect(saved).not.toHaveBeenCalled();
    http.verify();
  });

  it('a move registers the author in the new collection, then moves', async () => {
    const { http, saved, fixture } = await open();
    chooseTopic('udv');
    await fixture.whenStable();
    expect(screen.getByText(/Quem não vê este acervo/)).toBeTruthy();
    save();
    const author = http.expectOne(AUTHORS);
    expect(author.request.body).toEqual({ name: 'Mestre Laércio' });
    author.flush({
      slug: 'mestre-laercio',
      name: 'Mestre Laércio',
      main: false,
    });
    const request = http.expectOne(URL);
    expect(request.request.body).toEqual({
      topic: 'udv',
      author: 'mestre-laercio',
    });
    request.flush(aMediaItem({ topic: 'udv' }));
    await fixture.whenStable();
    expect(saved).toHaveBeenCalled();
    http.verify();
  });

  it('a move without an author says so, registering nothing', async () => {
    const { http, fixture } = await open(aMediaItem({ author: null }));
    chooseTopic('udv');
    save();
    // KBC-105: the click waits for the new collection's levels, then goes by itself.
    await fixture.whenStable();
    const request = http.expectOne(URL);
    expect(request.request.body).toEqual({ topic: 'udv', author: null });
    request.flush(aMediaItem({ topic: 'udv', author: null }));
    http.verify();
  });

  it('a cleared author becomes "Outros autores"', async () => {
    const { http } = await open();
    fireEvent.input(screen.getByLabelText('Autor'), {
      target: { value: '' },
    });
    save();
    const request = http.expectOne(URL);
    expect(request.request.body).toEqual({ author: null });
    request.flush(aMediaItem({ author: null }));
    http.verify();
  });

  it('FR-4: a server error keeps the dialog and what was typed', async () => {
    const { http, saved, fixture } = await open();
    typeTitle('Novo');
    save();
    http
      .expectOne(URL)
      .flush(
        { error: { code: 'FORBIDDEN', message: 'no' } },
        { status: 403, statusText: 'Forbidden' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain('permissão');
    expect(screen.getByLabelText<HTMLInputElement>('Título').value).toBe(
      'Novo',
    );
    expect(saved).not.toHaveBeenCalled();
  });

  it.each([
    [0, /verifique a conexão/],
    [502, /verifique a conexão/],
  ])('a status %d says to check the connection', async (status, text) => {
    const { http, fixture } = await open();
    save();
    http.expectOne(URL).flush(null, { status, statusText: 'Down' });
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toMatch(text);
  });

  it('a refused author is told as the author, a refused field as the fields', async () => {
    const { http, fixture } = await open();
    chooseTopic('udv');
    save();
    // KBC-105: the click waits for the new collection's levels, then goes by itself.
    await fixture.whenStable();
    http
      .expectOne(AUTHORS)
      .flush(
        { error: { code: 'VALIDATION_FAILED', message: 'no' } },
        { status: 400, statusText: 'Bad' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain('nome do autor');
    chooseTopic('hermetismo');
    save();
    // KBC-105: the click waits for the new collection's levels, then goes by itself.
    await fixture.whenStable();
    http
      .expectOne(URL)
      .flush(
        { error: { code: 'VALIDATION_FAILED', message: 'no' } },
        { status: 400, statusText: 'Bad' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain('revise os campos');
  });

  it('asks once, and Escape waits while it saves', async () => {
    const { http, closed, fixture } = await open();
    save();
    await fixture.whenStable();
    expect(screen.getByRole('button', { name: 'Salvando…' })).toHaveProperty(
      'disabled',
      true,
    );
    const dialog = screen.getByRole('dialog', { hidden: true });
    const cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel);
    expect(cancel.defaultPrevented).toBe(true);
    fireEvent.keyDown(screen.getByLabelText('Título'), { key: 'Escape' });
    await fixture.whenStable();
    expect(closed).not.toHaveBeenCalled();
    http.expectOne(URL).flush(ITEM);
    http.verify();
  });

  it('AC-7: Escape closes it from a text field, where WebKit on Linux fires no cancel', async () => {
    const { closed, http, fixture } = await open();
    fireEvent.keyDown(screen.getByLabelText('Título'), { key: 'Escape' });
    await fixture.whenStable();
    expect(closed).toHaveBeenCalledOnce();
    http.verify();
  });

  it("AC-7: Escape on the author's open list closes only the list", async () => {
    const { closed, http, fixture } = await open();
    const author = screen.getByRole('combobox', {
      name: 'Autor',
      hidden: true,
    });
    fireEvent.focus(author);
    TestBed.tick();
    http
      .expectOne(`/api/v1/topics/${ITEM.topic}/authors`)
      .flush({ items: [{ slug: 'ana', name: 'Ana', main: false }] });
    fireEvent.keyDown(author, { key: 'ArrowDown' });
    await fixture.whenStable();
    expect(author.getAttribute('aria-expanded')).toBe('true');
    fireEvent.keyDown(author, { key: 'Escape' });
    await fixture.whenStable();
    expect(author.getAttribute('aria-expanded')).toBe('false');
    expect(closed).not.toHaveBeenCalled();
    fireEvent.keyDown(author, { key: 'Escape' });
    await fixture.whenStable();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('Cancelar closes without sending', async () => {
    const { http, closed, fixture } = await open();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    await vi.waitFor(() => expect(closed).toHaveBeenCalled());
    http.verify();
  });

  describe('Nível (KBC-105)', () => {
    const LEVELLED = aMediaItem({ level: { id: 'ci', code: 'CI' } });
    const SCALES = { hermetismo: QS_CI, udv: [{ id: 'a1', code: 'A1' }] };

    it("BR-3: opens with the audio's level and sends a new one", async () => {
      const { http, fixture } = await open(LEVELLED, SCALES);
      const group = screen.getByRole('group', { name: 'Nível' });
      expect(
        screen.getByRole<HTMLInputElement>('radio', { name: 'CI' }).checked,
      ).toBe(true);
      fireEvent.click(screen.getByRole('radio', { name: 'QS' }));
      await fixture.whenStable();
      save();
      const request = http.expectOne(URL);
      expect(request.request.body).toEqual({ level: 'qs' });
      expect(group).toBeTruthy();
    });

    it('KBC-106 BR-1: raising it over a track of its own asks first, and says how many go up', async () => {
      const own = aMediaItem({
        level: { id: 'qs', code: 'QS' },
        ownTrackLevels: ['qs', 'ci'],
      });
      const { http, fixture } = await open(own, {
        hermetismo: [...QS_CI, { id: 'cdc', code: 'CDC' }],
      });
      fireEvent.click(screen.getByRole('radio', { name: 'CDC' }));
      await fixture.whenStable();
      save();
      await fixture.whenStable();
      const confirm = screen.getByRole('group', {
        name: '2 faixas com nível próprio sobem para CDC.',
      });
      expect(confirm).toBeTruthy();
      http.expectNone(URL);
      // One "Cancelar" only: the one of the dialog (review m5).
      expect(screen.getAllByRole('button', { name: 'Cancelar' })).toHaveLength(
        1,
      );
      expect(
        screen.getByRole('button', { name: 'Escolher outro nível' }),
      ).toBeTruthy();
      fireEvent.click(
        screen.getByRole('button', { name: 'Salvar e subir as faixas' }),
      );
      expect(http.expectOne(URL).request.body).toEqual({ level: 'cdc' });
    });

    it('sends no level when only the title changed', async () => {
      const { http } = await open(LEVELLED, SCALES);
      typeTitle('Outro título');
      save();
      expect(http.expectOne(URL).request.body).toEqual({
        title: 'Outro título',
      });
    });

    it('AC-9: a move to another scale asks "Nível em UDV", empty, before anything is sent', async () => {
      const { http, fixture } = await open(LEVELLED, SCALES);
      chooseTopic('udv');
      await fixture.whenStable();
      const there = screen.getByRole('group', { name: 'Nível em UDV' });
      const radio = screen.getByRole<HTMLInputElement>('radio', { name: 'A1' });
      expect(radio.checked).toBe(false);
      save();
      await fixture.whenStable();
      expect(there.textContent).toContain('Escolha o nível deste áudio.');
      http.expectNone(URL);
      http.expectNone(AUTHORS);

      fireEvent.click(radio);
      await fixture.whenStable();
      save();
      http
        .expectOne(AUTHORS)
        .flush({ slug: 'mestre-laercio', name: 'Mestre Laércio', main: false });
      expect(http.expectOne(URL).request.body).toEqual({
        topic: 'udv',
        author: 'mestre-laercio',
        level: 'a1',
      });
    });

    it('BR-4: a move to a collection without levels has no field and sends no level', async () => {
      const { http, fixture } = await open(LEVELLED, { hermetismo: QS_CI });
      chooseTopic('udv');
      await fixture.whenStable();
      expect(screen.queryByRole('group', { name: /Nível/ })).toBeNull();
      save();
      http
        .expectOne(AUTHORS)
        .flush({ slug: 'mestre-laercio', name: 'Mestre Laércio', main: false });
      expect(http.expectOne(URL).request.body).toEqual({
        topic: 'udv',
        author: 'mestre-laercio',
      });
    });
  });

  it('review round 1: a "Salvar" pressed while the levels load goes once they come', async () => {
    const held = holdingLevels('udv');
    const { http } = await open(aMediaItem({ author: null }), {}, [
      held.interceptor,
    ]);
    chooseTopic('udv');
    save();

    const button = await vi.waitFor(() =>
      screen.getByRole('button', { name: 'Carregando níveis…' }),
    );
    expect(button.getAttribute('aria-busy')).toBe('true');
    http.expectNone(URL);

    held.release([]);
    await vi.waitFor(() =>
      expect(http.expectOne(URL).request.body).toEqual({
        topic: 'udv',
        author: null,
      }),
    );
  });

  it('review round 2: a save held for the levels leaves no stuck button when the title is cleared', async () => {
    const held = holdingLevels('udv');
    const { http } = await open(aMediaItem({ author: null }), {}, [
      held.interceptor,
    ]);
    chooseTopic('udv');
    save();
    await vi.waitFor(() =>
      screen.getByRole('button', { name: 'Carregando níveis…' }),
    );
    typeTitle('');

    held.release([]);
    // The held save ran into the empty title: the button is back, nothing went.
    const button = await vi.waitFor(() =>
      screen.getByRole<HTMLButtonElement>('button', { name: 'Salvar' }),
    );
    expect(button.disabled).toBe(false);
    expect(button.hasAttribute('aria-busy')).toBe(false);
    expect(screen.getByText(/Dê um título ao áudio/)).toBeTruthy();
    http.expectNone(URL);
    typeTitle('Outro título');
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Salvar' })
        .disabled,
    ).toBe(false);
  });

  it('review round 2: with the levels failed for the new collection nothing is saved', async () => {
    let calls = 0;
    const failing: HttpInterceptorFn = (request, next) =>
      request.url.endsWith('/topics/udv/media/levels') && calls++ === 0
        ? throwError(
            () => new HttpErrorResponse({ status: 503, url: request.url }),
          )
        : next(request);
    const { http, fixture } = await open(aMediaItem({ author: null }), {}, [
      failing,
    ]);
    chooseTopic('udv');
    await fixture.whenStable();
    save();
    await fixture.whenStable();

    http.expectNone(URL);
    http.expectNone(AUTHORS);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Carregar níveis de novo' }),
    );
  });

  it('review round 3: a save held for the levels that then fail leaves the focus on "Carregar níveis de novo"', async () => {
    const held = holdingLevels('udv');
    const { http } = await open(aMediaItem({ author: null }), {}, [
      held.interceptor,
    ]);
    chooseTopic('udv');
    const button = screen.getByRole('button', { name: 'Salvar' });
    button.focus();
    save();
    const waiting = await vi.waitFor(() =>
      screen.getByRole('button', { name: 'Carregando níveis…' }),
    );
    expect(waiting.getAttribute('aria-disabled')).toBe('true');
    expect(document.activeElement).toBe(waiting);

    held.fail();
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('button', { name: 'Carregar níveis de novo' }),
      ),
    );
    http.expectNone(URL);
  });
});
