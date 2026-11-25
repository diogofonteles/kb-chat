import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { DocumentUpload, DocumentWork } from '@kb-chat/contracts';
import { MEDIA_POLL_MS } from '@features/media/media-polling.js';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import { sessionAs } from '../../testing/media-fixtures.js';
import { DocumentUploadsSection } from './document-uploads-section.js';
import { DocumentUploadsStore, REFRESH_MS } from './document-uploads-store.js';

const URL = '/api/v1/document-uploads';

const upload = (fields: Partial<DocumentUpload>): DocumentUpload => ({
  id: crypto.randomUUID(),
  topic: 'hermetismo',
  kind: 'file',
  name: 'Caibalion.pdf',
  state: 'received',
  failure: null,
  detail: null,
  document: null,
  mediaId: null,
  bytes: 10,
  received: 10,
  uploadUrl: null,
  review: false,
  batch: null,
  heldBy: null,
  retriable: false,
  progress: {
    startedAt: null,
    stalledSince: null,
    position: null,
    startsInSeconds: null,
    takesSeconds: null,
    media: null,
  },
  entryCount: 0,
  mine: true,
  refused: null,
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z',
  ...fields,
});

const progress = (
  fields: Partial<DocumentUpload['progress']>,
): DocumentUpload['progress'] => ({
  startedAt: null,
  stalledSince: null,
  position: null,
  startsInSeconds: null,
  takesSeconds: null,
  media: null,
  ...fields,
});

const aWork = (fields: Partial<DocumentWork> = {}): DocumentWork => ({
  mac: { state: 'on', lastSeenAt: new Date().toISOString(), doing: null },
  busy: false,
  waiting: 0,
  ...fields,
});

const secondsAgo = (seconds: number) =>
  new Date(Date.now() - seconds * 1_000).toISOString();

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function renderSection(
  items: DocumentUpload[],
  topic: string | null = null,
  said: { work?: DocumentWork; master?: boolean; listing?: boolean } = {},
) {
  const opened = vi.fn();
  const listEnded = vi.fn();
  const view = await render(DocumentUploadsSection, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      sessionAs({ features: ['media-upload'], master: said.master ?? false }),
      DocumentUploadsStore,
      { provide: MEDIA_POLL_MS, useValue: 20 },
    ],
    inputs: { topic, titles: new Map([['hermetismo', 'Hermetismo']]) },
    on: { documentOpened: opened, listEnded },
  });
  const http = TestBed.inject(HttpTestingController);
  await new Promise((resolve) => setTimeout(resolve, 5));
  http.expectOne(URL).flush({ items, ...(said.work && { work: said.work }) });
  // A list is being read: the page is not at rest until it comes.
  await (said.listing ? tick() : view.fixture.whenStable());
  return { ...view, http, opened, listEnded };
}

describe('Documentos em processamento (KBC-149 FR-2)', () => {
  it('shows each state in words, why one failed and "Abrir" once ready', async () => {
    const document = { id: 'raw/articles/c.md', title: 'O Caibalion' };
    const { opened } = await renderSection([
      upload({ name: 'convertendo.pdf', state: 'converting' }),
      upload({ name: 'no-mapa.pdf', state: 'mapped', document }),
      upload({ name: 'pronto.pdf', state: 'ready', document }),
      upload({
        kind: 'url',
        name: 'https://example.org/quebrado',
        state: 'failed',
        failure: 'conversion-failed',
      }),
    ]);

    expect(
      screen.getByRole('heading', { name: 'Documentos em processamento' }),
    ).toBeTruthy();
    expect(screen.getByText('Convertendo')).toBeTruthy();
    expect(screen.getByText('No mapa')).toBeTruthy();
    expect(screen.getByText(/próxima sincronização/)).toBeTruthy();
    expect(screen.getByText('Pronto')).toBeTruthy();
    expect(screen.getByText('Falhou')).toBeTruthy();
    expect(screen.getByText(/Não consegui converter/)).toBeTruthy();
    expect(screen.getAllByText('Hermetismo')).toHaveLength(4);
    const open = screen.getAllByRole('button', { name: 'Abrir' });
    expect(open).toHaveLength(1);
    fireEvent.click(open[0] as HTMLElement);
    expect(opened).toHaveBeenCalledWith({ topic: 'hermetismo', ...document });
  });

  it('reads again while something is on its way, and stops once all settled', async () => {
    const { http, fixture } = await renderSection([
      upload({ state: 'converting' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 40));
    http
      .expectOne(URL)
      .flush({ items: [upload({ state: 'failed', failure: 'empty' })] });
    await fixture.whenStable();
    expect(screen.getByText(/saiu vazia/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 60));
    http.expectNone(URL);
  });

  it('many asks at once are one read now and one at the end', async () => {
    const { http, fixture } = await renderSection([
      upload({ state: 'failed', failure: 'empty' }),
    ]);
    const store = fixture.debugElement.injector.get(DocumentUploadsStore);
    vi.useFakeTimers();
    try {
      for (let n = 0; n < 100; n += 1) store.refresh();
      http.expectOne(URL).flush({ items: [] });
      vi.advanceTimersByTime(REFRESH_MS + 1);
      http.expectOne(URL).flush({ items: [] });
      vi.advanceTimersByTime(REFRESH_MS * 3);
      http.expectNone(URL);
    } finally {
      vi.useRealTimers();
    }
  });

  it("what is in the collection and in kb's review says so", async () => {
    const document = { id: 'raw/a.md', title: 'A' };
    await renderSection([upload({ state: 'ready', document, review: true })]);
    expect(screen.getByText('Pronto')).toBeTruthy();
    expect(screen.getByText(/fila de revisão do dono/)).toBeTruthy();
  });

  it('shows nothing when nothing was sent', async () => {
    await renderSection([]);
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('in "Adicionar conteúdo" shows only the chosen collection, without naming it', async () => {
    await renderSection(
      [upload({ name: 'a.pdf' }), upload({ name: 'b.pdf', topic: 'udv' })],
      'hermetismo',
    );
    expect(screen.getByText('a.pdf')).toBeTruthy();
    expect(screen.queryByText('b.pdf')).toBeNull();
    expect(screen.queryByText('Hermetismo')).toBeNull();
  });

  it("says which ceiling an item waits for, and raises the inclusion's by 0,50", async () => {
    const batch = { id: crypto.randomUUID(), capUsd: 0.5, spentUsd: 0.5 };
    const { http, fixture } = await renderSection([
      upload({ name: 'a.pdf', heldBy: 'batch-cap', batch }),
      upload({ name: 'b.pdf', heldBy: 'month-cap' }),
    ]);
    expect(
      screen.getByText(/teto desta inclusão \(US\$ 0[.,]50\)/),
    ).toBeTruthy();
    expect(screen.getByText(/teto de gasto do mês/)).toBeTruthy();
    const raise = screen.getAllByRole('button', { name: /Aumentar o teto/ });
    expect(raise).toHaveLength(1);
    fireEvent.click(raise[0] as HTMLElement);
    const patch = http.expectOne(`/api/v1/document-batches/${batch.id}`);
    expect(patch.request.body).toEqual({ capUsd: 1 });
    patch.flush({ ...batch, capUsd: 1 });
    http.match(URL).forEach((one) => one.flush({ items: [] }));
    await fixture.whenStable();
    expect(screen.queryByRole('heading')).toBeNull();
  });

  it('an inclusion at the largest ceiling cannot be raised further', async () => {
    const batch = { id: crypto.randomUUID(), capUsd: 100, spentUsd: 100 };
    await renderSection([upload({ heldBy: 'batch-cap', batch })]);
    expect(
      screen.queryByRole('button', { name: /Aumentar o teto/ }),
    ).toBeNull();
  });

  it('the focus is never lost with the button that goes away (review B, I3)', async () => {
    const { http, fixture } = await renderSection([
      upload({
        name: 'a.pdf',
        state: 'failed',
        failure: 'empty',
        retriable: true,
      }),
    ]);
    const title = screen.getByRole('heading', {
      name: 'Documentos em processamento',
    });
    const button = screen.getByRole('button', { name: /^Tirar/ });
    button.focus();
    fireEvent.click(button);
    await fixture.whenStable();
    expect(document.activeElement).toBe(title);
    http
      .expectOne((one) => one.method === 'DELETE')
      .flush('', { status: 500, statusText: 'x' });
  });

  it('a failed item the app still has goes again; one it does not have is not offered', async () => {
    const failed = upload({
      name: 'a.pdf',
      state: 'failed',
      failure: 'gave-up',
      retriable: true,
    });
    const { http } = await renderSection([
      failed,
      upload({ name: 'b.pdf', state: 'failed', failure: 'empty' }),
    ]);
    const retry = screen.getAllByRole('button', { name: 'Tentar de novo' });
    expect(retry).toHaveLength(1);
    fireEvent.click(retry[0] as HTMLElement);
    const post = http.expectOne(`${URL}/${failed.id}/retry`);
    expect(post.request.method).toBe('POST');
  });

  it('takes an item out, except one the Mac works on; a refusal says why', async () => {
    const waiting = upload({ name: 'a.pdf' });
    const { http, fixture } = await renderSection([
      waiting,
      upload({ name: 'b.pdf', state: 'converting' }),
    ]);
    expect(
      screen.queryByRole('button', { name: 'Tirar b.pdf da lista' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Tirar a.pdf da lista' }),
    );
    http.expectOne(`${URL}/${waiting.id}`).flush(
      {
        error: { code: 'MEDIA_CONFLICT', message: 'x', requestId: 'r' },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();
    expect(screen.getByText('Não consegui fazer isso')).toBeTruthy();
  });

  it('a folder of hundreds shows the first ones, and the rest one press away', async () => {
    const many = Array.from({ length: 45 }, (_, n) =>
      upload({ name: `${n}.pdf`, state: 'ready' }),
    );
    const { fixture } = await renderSection(many);
    expect(screen.getAllByRole('listitem')).toHaveLength(30);
    fireEvent.click(screen.getByRole('button', { name: 'Ver os outros 15' }));
    await fixture.whenStable();
    expect(screen.getAllByRole('listitem')).toHaveLength(45);
  });

  it('a list offers what it holds; what is chosen goes, and nothing before', async () => {
    const list = upload({
      kind: 'list',
      name: 'https://www.youtube.com/playlist?list=PL1',
      state: 'choosing',
      entryCount: 2,
    });
    const { http, fixture } = await renderSection([list], null, {
      listing: true,
    });
    expect(screen.getByText('Escolha o que entra')).toBeTruthy();
    expect(screen.getByText('Lendo a lista…')).toBeTruthy();
    http.expectOne(`${URL}/${list.id}/entries`).flush({
      entries: [
        { url: 'https://youtu.be/1', title: 'Aula 1', durationS: 60 },
        { url: 'https://youtu.be/2', title: 'Aula 2', durationS: null },
      ],
    });
    await fixture.whenStable();
    http.expectNone((request) => request.method === 'POST');
    fireEvent.click(screen.getByRole('checkbox', { name: /Aula 2/ }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Incluir 1 gravação' }));
    const post = http.expectOne(`${URL}/${list.id}/choose`);
    expect(post.request.body).toEqual({ urls: ['https://youtu.be/2'] });
    post.flush({ created: 1, already: 0 });
    http.match(URL).forEach((one) => one.flush({ items: [] }));
    await fixture.whenStable();
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('a list that could not be read says so, and is read again when asked', async () => {
    const list = upload({ kind: 'list', state: 'choosing', entryCount: 1 });
    const { http, fixture } = await renderSection([list], null, {
      listing: true,
    });
    http
      .expectOne(`${URL}/${list.id}/entries`)
      .flush(null, { status: 503, statusText: 'Service Unavailable' });
    await fixture.whenStable();
    const again = screen.getByRole('button', { name: 'Tentar de novo' });
    again.focus();
    fireEvent.click(again);
    await tick();
    // Its button is gone: the focus is where the list will be (WCAG 2.4.3).
    const held = document.activeElement;
    expect(held?.classList.contains('box')).toBe(true);
    http.expectOne(`${URL}/${list.id}/entries`).flush({
      entries: [{ url: 'https://youtu.be/1', title: 'Aula 1', durationS: 60 }],
    });
    await fixture.whenStable();
    expect(screen.getByRole('checkbox', { name: /Aula 1/ })).toBeTruthy();
    expect(document.activeElement).toBe(held);
  });
});

const card = () =>
  document.querySelector('app-document-work-card') as HTMLElement;

describe('what is being done (KBC-184)', () => {
  const rowOf = (name: string) =>
    screen.getByText(name).closest('app-document-upload-row') as HTMLElement;
  const batch = { id: crypto.randomUUID(), capUsd: 0.5, spentUsd: 0.018 };

  it('says how everything stands, what the Mac does now, what is left and what was spent', async () => {
    await renderSection(
      [
        upload({
          name: 'a.pdf',
          state: 'converting',
          batch,
          progress: progress({ startedAt: secondsAgo(70), takesSeconds: 30 }),
        }),
        upload({
          name: 'b.pdf',
          batch,
          progress: progress({
            position: 1,
            startsInSeconds: 30,
            takesSeconds: 60,
          }),
        }),
        upload({
          name: 'c.pdf',
          batch,
          progress: progress({
            position: 2,
            startsInSeconds: 90,
            takesSeconds: 60,
          }),
        }),
        upload({ name: 'd.pdf', state: 'failed', failure: 'empty', batch }),
        upload({ name: 'e.pdf', state: 'ready', batch }),
      ],
      null,
      { work: aWork({ busy: true, waiting: 2 }) },
    );
    const text = within(card());
    expect(text.getByText('1 de 5 prontos')).toBeTruthy();
    expect(
      text.getByText('1 em andamento · 2 na fila · 1 falhou'),
    ).toBeTruthy();
    expect(text.getByText('Mac conectado')).toBeTruthy();
    expect(text.getByText('a.pdf — Convertendo, há 1 min')).toBeTruthy();
    // The last one starts in 90 s and takes 60.
    expect(text.getByText('cerca de 3 min no Mac')).toBeTruthy();
    expect(text.getByText(/US\$ 0[.,]02 de US\$ 0[.,]50/)).toBeTruthy();

    expect(
      within(rowOf('a.pdf')).getByText(/Há 1 min · falta menos de 1 min/),
    ).toBeTruthy();
    expect(within(rowOf('a.pdf')).getByText('Etapa 2 de 5')).toBeTruthy();
    expect(
      within(rowOf('b.pdf')).getByText(
        'Próximo da fila · começa em menos de 1 min',
      ),
    ).toBeTruthy();
    expect(
      within(rowOf('c.pdf')).getByText('2º na fila · começa em cerca de 2 min'),
    ).toBeTruthy();
    // What needs a look first, then the line in its order, then what is done.
    const names = screen
      .getAllByRole('listitem')
      .map((one) => one.querySelector('.name')?.textContent);
    expect(names).toEqual(['a.pdf', 'd.pdf', 'b.pdf', 'c.pdf', 'e.pdf']);
  });

  it('with no Mac says so, and a master is led to link one', async () => {
    const none = aWork({
      mac: { state: 'none', lastSeenAt: null, doing: null },
      waiting: 1,
    });
    const waiting = upload({
      progress: progress({ position: 1, takesSeconds: 60 }),
    });
    await renderSection([waiting], null, { work: none, master: true });
    expect(screen.getByText('Nenhum Mac conectado')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Abrir Transcritores' })
        .getAttribute('href'),
    ).toBe('/configuracoes/transcritores');
    expect(screen.queryByText(/liga sozinho/)).toBeNull();
    expect(screen.getByText('Próximo da fila')).toBeTruthy();
  });

  it('a member is told who links one', async () => {
    const none = aWork({
      mac: { state: 'none', lastSeenAt: null, doing: null },
      waiting: 1,
    });
    await renderSection([upload({})], null, { work: none });
    expect(screen.getByText(/Peça a um master/)).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('with the Mac off says since when, and that it comes on by itself', async () => {
    const off = aWork({
      mac: { state: 'off', lastSeenAt: secondsAgo(2 * 60 * 60), doing: null },
      waiting: 1,
    });
    await renderSection([upload({})], null, { work: off });
    expect(screen.getByText('Mac desligado')).toBeTruthy();
    expect(screen.getByText(/Visto há 2 h\..*liga sozinho/)).toBeTruthy();
  });

  it('says it is at something else, and nothing of the Mac once all ended', async () => {
    const { http, fixture } = await renderSection([upload({})], null, {
      work: aWork({ busy: true, waiting: 1 }),
    });
    expect(screen.getByText(/outro acervo agora/)).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 40));
    http
      .expectOne(URL)
      .flush({ items: [upload({ state: 'ready' })], work: aWork() });
    await fixture.whenStable();
    expect(screen.queryByText(/Mac conectado/)).toBeNull();
    expect(screen.getByText('1 de 1 pronto')).toBeTruthy();
  });

  it.each([
    {
      media: { step: 'preparing', percent: 40 },
      pill: 'Transcrevendo',
      text: 'Preparando o áudio · 40%',
    },
    {
      media: { step: 'waiting', percent: null },
      pill: 'Transcrevendo',
      text: /esperando a vez de transcrever/,
    },
    {
      media: { step: 'transcribing', percent: 12 },
      pill: 'Transcrevendo',
      text: /ouvindo e escrevendo · 12%/,
    },
    {
      media: { step: 'publishing', percent: null },
      pill: 'Classificando',
      text: /o kb classifica e publica/,
    },
    {
      media: { step: 'attention', percent: null },
      pill: 'Espera você',
      text: /Espera você na Fila/,
    },
  ] as const)(
    'a recording in the library that is $media.step says so',
    async ({ media, pill, text }) => {
      await renderSection([
        upload({
          kind: 'recording',
          state: 'transcribing',
          progress: progress({ media }),
        }),
      ]);
      expect(screen.getByText(pill)).toBeTruthy();
      expect(screen.getByText(text)).toBeTruthy();
    },
  );

  it('a recording on the Mac is being downloaded, and a list read', async () => {
    await renderSection([
      upload({ kind: 'recording', state: 'converting' }),
      upload({ kind: 'list', state: 'converting' }),
    ]);
    expect(screen.getByText('Baixando')).toBeTruthy();
    expect(screen.getByText('Lendo a lista')).toBeTruthy();
  });

  it('many items can be looked at by how they stand', async () => {
    const { fixture } = await renderSection([
      ...Array.from({ length: 12 }, (_, n) => upload({ name: `${n}.pdf` })),
      upload({ name: 'falhou.pdf', state: 'failed', failure: 'empty' }),
    ]);
    const filters = within(screen.getByRole('group', { name: 'Mostrar' }));
    expect(
      filters.getAllByRole('button').map((one) => one.textContent?.trim()),
    ).toEqual(['Todos (13)', 'Na fila (12)', 'Falharam (1)']);
    fireEvent.click(filters.getByRole('button', { name: 'Falharam (1)' }));
    await fixture.whenStable();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
    expect(screen.getByText('falhou.pdf')).toBeTruthy();
  });

  it('a few items have no filters', async () => {
    await renderSection([upload({}), upload({})]);
    expect(screen.queryByRole('group', { name: 'Mostrar' })).toBeNull();
  });

  it('what is ready is cleared together, and the focus stays in the section', async () => {
    const done = upload({ state: 'ready' });
    const { http, fixture } = await renderSection(
      [done, upload({ name: 'fica.pdf' })],
      'hermetismo',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Limpar prontos (1)' }));
    const post = http.expectOne(`${URL}/clear-ready`);
    expect(post.request.body).toEqual({ ids: [done.id] });
    expect(document.activeElement?.textContent).toContain(
      'Documentos em processamento',
    );
    post.flush({ cleared: 1 });
    http
      .match(URL)
      .forEach((one) => one.flush({ items: [upload({ name: 'fica.pdf' })] }));
    await fixture.whenStable();
    expect(screen.queryByRole('button', { name: /Limpar/ })).toBeNull();
    expect(screen.getByText('fica.pdf')).toBeTruthy();
  });

  it("another person's ready item is theirs to clear", async () => {
    await renderSection([upload({ state: 'ready', mine: false })], null, {
      master: true,
    });
    expect(screen.queryByRole('button', { name: /Limpar/ })).toBeNull();
  });

  it('cleared to nothing, the page is told to take the focus (WCAG 2.4.3)', async () => {
    const { http, fixture, listEnded } = await renderSection([
      upload({ state: 'ready' }),
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Limpar prontos (1)' }));
    http.expectOne(`${URL}/clear-ready`).flush({ cleared: 1 });
    expect(listEnded).not.toHaveBeenCalled();
    http.match(URL).forEach((one) => one.flush({ items: [] }));
    await fixture.whenStable();
    expect(screen.queryByText('Documentos em processamento')).toBeNull();
    expect(listEnded).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['recording', 'Está transcrevendo uma gravação agora.'],
    ['publishing', 'Está publicando uma transcrição no acervo agora.'],
  ] as const)(
    'the Mac at something else (%s) says so, never "em instantes"',
    async (doing, text) => {
      await renderSection(
        [upload({ progress: progress({ position: 1, takesSeconds: 60 }) })],
        null,
        {
          work: aWork({
            mac: { state: 'on', lastSeenAt: secondsAgo(1), doing },
            waiting: 1,
          }),
        },
      );
      expect(card().textContent).toContain(text);
      expect(document.body.textContent).not.toContain('em instantes');
    },
  );
});

describe('what kb refused (KBC-009)', () => {
  const refused = (fields: Partial<DocumentUpload['refused'] & object> = {}) =>
    upload({
      kind: 'url',
      name: 'Vídeo do site',
      state: 'failed',
      failure: 'not-accepted',
      detail: 'kb triage: quarantined',
      retriable: true,
      refused: {
        why: 'thin',
        excerpt: '# Entrar\n\nEsqueceu a senha?',
        acceptable: true,
        accepted: false,
        ...fields,
      },
    });

  it('a master reads why, sees what was read, and puts it in all the same', async () => {
    const one = refused();
    const { http, fixture } = await renderSection([one], null, {
      master: true,
    });
    expect(screen.getByText('Espera você')).toBeTruthy();
    expect(
      screen.getByText(/tela de entrada do site.*até você decidir/),
    ).toBeTruthy();
    expect(screen.queryByText(/quarantined/)).toBeNull();
    const show = screen.getByRole('button', { name: 'Ver o que foi lido' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(show);
    await fixture.whenStable();
    expect(
      screen.getByRole('region', { name: 'O que foi lido de Vídeo do site' })
        .textContent,
    ).toContain('Esqueceu a senha?');
    fireEvent.click(
      screen.getByRole('button', { name: 'Incluir mesmo assim' }),
    );
    http.expectOne(`${URL}/${one.id}/accept`).flush({});
    http
      .match(URL)
      .forEach((req) =>
        req.flush({ items: [{ ...one, state: 'received', refused: null }] }),
      );
    await fixture.whenStable();
    expect(screen.queryByText(/até você decidir/)).toBeNull();
    expect(document.activeElement?.textContent).toContain(
      'Documentos em processamento',
    );
  });

  it("accepted and not done by the Mac, it says so, with the Mac's words", async () => {
    const one = {
      ...refused({ accepted: true }),
      failure: 'gave-up' as const,
      detail: 'kb review: no item waits',
    };
    const { http, fixture } = await renderSection([one], null, {
      master: true,
    });
    expect(screen.getByText('Falhou')).toBeTruthy();
    expect(screen.getByText(/incluiu mesmo assim, mas o Mac/)).toBeTruthy();
    expect(screen.getByText('kb review: no item waits')).toBeTruthy();
    expect(screen.queryByText(/até você decidir/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ver o que foi lido' }));
    await fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: 'Incluir mesmo assim' }),
    );
    http
      .expectOne(`${URL}/${one.id}/accept`)
      .flush(
        { error: { code: 'DOCUMENT_DUPLICATE', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'O mesmo documento já está no acervo',
    );
  });

  it('what was read of a level no longer theirs has nothing to open', async () => {
    await renderSection([refused({ acceptable: false, excerpt: null })]);
    expect(screen.getByText(/até um master decidir/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Ver o que foi lido' }),
    ).toBeNull();
  });

  it('left out, it leaves the list', async () => {
    const one = refused({ why: 'off_topic' });
    const { http, fixture } = await renderSection([one]);
    expect(screen.getByText(/Não parece ser sobre este acervo/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver o que foi lido' }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Deixar de fora' }));
    const gone = http.expectOne(`${URL}/${one.id}`);
    expect(gone.request.method).toBe('DELETE');
    gone.flush(null);
  });

  it('who is not a master sees why and what was read, and that a master decides', async () => {
    const { fixture } = await renderSection([
      refused({ acceptable: false, why: 'algo_novo', excerpt: '' }),
    ]);
    expect(screen.getByText('Falhou')).toBeTruthy();
    expect(screen.getByText(/até um master decidir/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver o que foi lido' }));
    await fixture.whenStable();
    expect(screen.getByText('(nenhum texto)')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Incluir mesmo assim' }),
    ).toBeNull();
  });

  it('what a master decides comes to who sent it by itself', async () => {
    const one = refused({ acceptable: false });
    const { http, fixture } = await renderSection([one]);
    await new Promise((resolve) => setTimeout(resolve, 60));
    http
      .match(URL)
      .forEach((req) =>
        req.flush({ items: [{ ...one, state: 'received', refused: null }] }),
      );
    await fixture.whenStable();
    expect(screen.queryByText(/até um master decidir/)).toBeNull();
    expect(
      screen.getByText('Recebido', { selector: 'ui-pill, ui-pill *' }),
    ).toBeTruthy();
  });

  it('decided in another place first, it says so and reads the list again', async () => {
    const one = refused();
    const { http, fixture } = await renderSection([one]);
    fireEvent.click(screen.getByRole('button', { name: 'Ver o que foi lido' }));
    await fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: 'Incluir mesmo assim' }),
    );
    http
      .expectOne(`${URL}/${one.id}/accept`)
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Este item mudou enquanto isso',
    );
  });

  it('a channel with nothing in it says that, not of a scan', async () => {
    await renderSection([
      upload({ kind: 'list', state: 'failed', failure: 'empty' }),
    ]);
    expect(screen.getByText('Não há gravações nesta lista.')).toBeTruthy();
  });
});

describe('the Mac that stopped in the middle (KBC-184)', () => {
  const stalled = () =>
    upload({
      name: 'livro.pdf',
      state: 'converting',
      progress: progress({ stalledSince: secondsAgo(250) }),
    });

  it('says it is stopped and since when, and one press resumes it', async () => {
    const one = stalled();
    const { http, fixture } = await renderSection([one], null, {
      work: aWork(),
    });
    expect(screen.getByText('Parado')).toBeTruthy();
    expect(screen.getByText(/não dá sinal há 4 min/)).toBeTruthy();
    expect(card().textContent).toContain('1 espera você');
    expect(card().textContent).not.toContain('Agora');
    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }));
    http.expectOne(`${URL}/${one.id}/resume`).flush({});
    http
      .match(URL)
      .forEach((req) => req.flush({ items: [{ ...one, state: 'received' }] }));
    await fixture.whenStable();
    expect(document.activeElement?.textContent).toContain(
      'Documentos em processamento',
    );
  });

  it('a Mac that came back meanwhile is told, and the list read again', async () => {
    const one = stalled();
    const { http, fixture } = await renderSection([one]);
    fireEvent.click(screen.getByRole('button', { name: 'Retomar' }));
    http
      .expectOne(`${URL}/${one.id}/resume`)
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Este item mudou enquanto isso',
    );
  });
});
