import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import {
  provideZonelessChangeDetection,
  signal,
  type WritableSignal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  convertToParamMap,
  provideRouter,
} from '@angular/router';
import type { Feature, Topic } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { MEDIA_POLL_MS } from '@features/media/media-polling.js';
import { fireEvent, render, screen, waitFor } from '@testing-library/angular';
import { of } from 'rxjs';
import { DocumentUploadsStore } from '@features/document-upload/document-uploads-store.js';
import { AddContentPage } from './add-content-page.js';
import {
  ContentSender,
  type ContentSend,
  type SendPhase,
} from './content-sender.js';

const topic = (slug: string, title: string): Topic =>
  ({
    slug,
    title,
    description: '',
    parent: null,
    canOpen: true,
    canRename: true,
    documentCount: 0,
    trackCount: 0,
    mainAuthor: null,
  }) as unknown as Topic;

async function renderPage(
  options: {
    asked?: string;
    features?: Feature[];
    levels?: { id: string; code: string }[];
  } = {},
) {
  const topics = [topic('hermetismo', 'Hermetismo'), topic('udv', 'UDV')];
  const chat = {
    topicList: signal(topics),
    topicSlug: signal('hermetismo'),
    putTopic: vi.fn(),
    open: vi.fn(),
  };
  const features = new Set(
    options.features ?? ['media', 'media-upload', 'collection-create'],
  );
  const view = await render(AddContentPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: MEDIA_POLL_MS, useValue: 60_000 },
      { provide: ChatStore, useValue: chat },
      {
        provide: SessionStore,
        useValue: {
          can: (one: Feature) => features.has(one),
          me: signal({ media: true, levelsManager: false }),
          isMaster: signal(false),
        },
      },
      {
        provide: ActivatedRoute,
        useValue: {
          queryParamMap: of(
            convertToParamMap(options.asked ? { acervo: options.asked } : {}),
          ),
        },
      },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  await waitFor(() => http.expectOne('/api/v1/document-uploads')).then((one) =>
    one.flush({ items: [] }),
  );
  const costs = await waitFor(() =>
    http.expectOne('/api/v1/document-uploads/costs'),
  );
  const cost = { usd: 0.003, seconds: 60, samples: 0 };
  costs.flush({ document: cost, image: cost, page: cost, recording: cost });
  const levels = await waitFor(() =>
    http.expectOne((request) => request.url.endsWith('/media/levels')),
  );
  levels.flush({ collection: 'x', levels: options.levels ?? [] });
  await view.fixture.whenStable();
  return { ...view, http, chat, levelsUrl: levels.request.url };
}

const where = () =>
  screen.getByRole('combobox', { name: 'Acervo' }) as HTMLSelectElement;
const include = () =>
  screen.getByRole('button', { name: /^Incluir/ }) as HTMLButtonElement;

async function typeLinks(
  text: string,
  fixture: { whenStable(): Promise<unknown> },
) {
  fireEvent.click(screen.getByRole('button', { name: 'Links' }));
  await fixture.whenStable();
  fireEvent.input(screen.getByLabelText('Endereços'), {
    target: { value: text },
  });
  await fixture.whenStable();
}

describe('AddContentPage (KBC-184)', () => {
  it('starts on the collection of the address, else on the one in use', async () => {
    const { levelsUrl } = await renderPage({ asked: 'udv' });
    expect(where().value).toBe('udv');
    expect(levelsUrl).toContain('/topics/udv/');
  });

  it('a collection the person does not see falls back to the one in use', async () => {
    await renderPage({ asked: 'segredo' });
    expect(where().value).toBe('hermetismo');
  });

  it('sends several links as one inclusion with its ceiling, and keeps what was refused', async () => {
    const { http, fixture } = await renderPage();
    expect(include().disabled).toBe(true);
    await typeLinks(
      'https://example.org/1\nhttps://example.org/2\nnão é link',
      fixture,
    );
    expect(screen.getByText('2 endereços prontos')).toBeTruthy();
    expect(screen.getByText(/Não é um endereço: não é link/)).toBeTruthy();
    expect(
      screen.getByRole('region', { name: 'Quanto deve custar' }),
    ).toBeTruthy();
    expect(screen.getByText('2 páginas da web')).toBeTruthy();
    fireEvent.input(screen.getByLabelText(/Teto desta inclusão/), {
      target: { value: '1,25' },
    });
    await fixture.whenStable();
    fireEvent.click(include());
    const sent = http.expectOne('/api/v1/topics/hermetismo/documents');
    expect(sent.request.body).toMatchObject({
      kind: 'url',
      url: 'https://example.org/1',
      batch: { capUsd: 1.25 },
    });
    await fixture.whenStable();
    expect(
      (screen.getByLabelText('Endereços') as HTMLTextAreaElement).value,
    ).toBe('não é link');
    expect(screen.getByRole('region', { name: 'Enviados agora' })).toBeTruthy();
  });

  it.each(['', 'abc', '0,01', '5,01'])(
    'a ceiling of "%s" is refused with its range',
    async (value) => {
      const { fixture } = await renderPage();
      await typeLinks('https://example.org/1', fixture);
      fireEvent.input(screen.getByLabelText(/Teto desta inclusão/), {
        target: { value },
      });
      await fixture.whenStable();
      expect(screen.getByText('De 0,05 a 5,00.')).toBeTruthy();
      expect(include().disabled).toBe(true);
    },
  );

  it('more than 50 links at once are refused', async () => {
    const { fixture } = await renderPage();
    const many = Array.from(
      { length: 51 },
      (_, n) => `https://example.org/${n}`,
    );
    await typeLinks(many.join('\n'), fixture);
    expect(screen.getByText('Inclua até 50 endereços por vez.')).toBeTruthy();
    expect(include().disabled).toBe(true);
  });

  it('in a collection with levels nothing goes without one', async () => {
    const { http, fixture } = await renderPage({
      levels: [{ id: 'qs', code: 'QS' }],
    });
    await typeLinks('https://example.org/1', fixture);
    fireEvent.click(include());
    await fixture.whenStable();
    http.expectNone('/api/v1/topics/hermetismo/documents');
    fireEvent.click(screen.getByRole('radio', { name: /QS/ }));
    await fixture.whenStable();
    fireEvent.click(include());
    expect(
      http.expectOne('/api/v1/topics/hermetismo/documents').request.body,
    ).toMatchObject({ level: 'qs' });
  });

  const pick = async (
    selector: string,
    files: readonly File[],
    fixture: { whenStable(): Promise<unknown> },
  ) => {
    const input = document.querySelector(selector) as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: files, configurable: true });
    fireEvent.change(input);
    await fixture.whenStable();
  };

  it('a folder: says how much was found, what goes and what does not, with why', async () => {
    const { fixture } = await renderPage();
    const files = ['a.pdf', 'b.mp3', '.DS_Store', 'c.exe'].map((name) => {
      const file = new File(['x'], name);
      Object.defineProperty(file, 'webkitRelativePath', {
        value: `Pasta/${name}`,
      });
      return file;
    });
    await pick('.folder-input', files, fixture);
    expect(screen.getByText('4 arquivos encontrados')).toBeTruthy();
    expect(
      screen.getByText('1 documento · 1 áudio · 2 não entram'),
    ).toBeTruthy();
    expect(screen.getByText('Não entram (2)')).toBeTruthy();
    expect(screen.getByText('Pasta/c.exe')).toBeTruthy();
    expect(screen.getByText(/Este tipo de arquivo não entra/)).toBeTruthy();
    expect(include().textContent).toContain('Incluir 2 itens');
    // The same folder chosen again adds nothing.
    await pick('.folder-input', files, fixture);
    expect(screen.getByText('4 arquivos encontrados')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Tirar Pasta/a.pdf da lista' }),
    );
    await fixture.whenStable();
    expect(include().textContent).toContain('Incluir 1 item');
    fireEvent.click(screen.getByRole('button', { name: 'Limpar' }));
    await fixture.whenStable();
    expect(include().disabled).toBe(true);
  });

  it('a folder with images, audios and videos is estimated by kind; a video goes by its sound', async () => {
    const { http, fixture } = await renderPage();
    const files = ['a.pdf', 'b.png', 'c.mp3', 'd.mp4'].map(
      (name) => new File(['x'], name),
    );
    await pick('input[type="file"]:not(.folder-input)', files, fixture);
    expect(screen.getByText('2 documentos · 1 áudio · 1 vídeo')).toBeTruthy();
    expect(screen.getByText('1 documento')).toBeTruthy();
    expect(screen.getByText('1 imagem')).toBeTruthy();
    expect(screen.getByText('2 áudios e vídeos')).toBeTruthy();
    http.expectNone((request) => request.method === 'POST');
  });

  it('a folder past the ceiling says so before, and one press fits it', async () => {
    const { fixture } = await renderPage();
    const many = Array.from(
      { length: 300 },
      (_, n) => new File(['x'], `${n}.pdf`),
    );
    await pick('input[type="file"]:not(.folder-input)', many, fixture);
    expect(screen.getByText('A estimativa passa do teto')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Usar US\$/ }));
    await fixture.whenStable();
    expect(screen.queryByText('A estimativa passa do teto')).toBeNull();
  });

  it('warns before leaving only while something is being sent', async () => {
    const { fixture } = await renderPage();
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
    await typeLinks('https://example.org/1', fixture);
    fireEvent.click(include());
    await fixture.whenStable();
    const sending = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(sending);
    expect(sending.defaultPrevented).toBe(true);
  });

  it('searches the web, estimates what is picked and includes it with the rest', async () => {
    const { fixture, http } = await renderPage();
    const settle = async () => {
      await new Promise((resolve) => setTimeout(resolve));
      TestBed.tick();
      await new Promise((resolve) => setTimeout(resolve));
    };
    fireEvent.click(screen.getByRole('button', { name: 'Pesquisar na web' }));
    await settle();
    http
      .expectOne('/api/v1/web-search/available')
      .flush({ connected: true, low: false });
    await settle();
    fireEvent.input(screen.getByLabelText('Assunto'), {
      target: { value: 'hermetismo' },
    });
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Pesquisar' }));
    await settle();
    const result = (kind: string, url: string) => ({
      ...{ kind, url, title: url, snippet: '', site: 'x.org' },
      ...{ author: null, already: null },
    });
    http
      .expectOne((one) => one.url.endsWith('/hermetismo/web-search'))
      .flush({
        results: [
          result('text', 'https://x.org/1'),
          result('video', 'https://youtu.be/abc'),
        ],
        ...{ creditsUsed: 2, creditsRemaining: 900 },
        ...{ low: false, partial: false },
      });
    await settle();
    expect(screen.getByText('1 página da web')).toBeTruthy();
    expect(screen.getByText('1 áudio ou vídeo')).toBeTruthy();

    // Another tab and back: a paid search is not lost.
    fireEvent.click(screen.getByRole('button', { name: 'Links' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Pesquisar na web' }));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Incluir 2 itens' }));
    await settle();
    const bodies = [];
    for (let n = 0; n < 2; n += 1) {
      const asked = http.expectOne(
        (one) => one.method === 'POST' && one.url.endsWith('/documents'),
      );
      bodies.push(asked.request.body);
      asked.flush({ outcome: 'duplicate', document: null, upload: null });
      await settle();
    }
    expect(bodies).toMatchObject([
      { url: 'https://x.org/1', as: 'page' },
      { url: 'https://youtu.be/abc', as: 'recording' },
    ]);
    expect(bodies[0].batch).toEqual(bodies[1].batch);
    expect(screen.getAllByText('Incluído agora')).toHaveLength(2);
    expect(include().disabled).toBe(true);
    fixture.destroy();
  });

  it('leaving the page inside the app stops nothing: the sends go on and are found on coming back', async () => {
    const { fixture, http } = await renderPage();
    await typeLinks('https://example.org/1\nhttps://example.org/2', fixture);
    fireEvent.click(include());
    await fixture.whenStable();
    const sender = TestBed.inject(ContentSender);
    fixture.destroy();
    expect(sender.busy()).toBe(true);
    for (const n of [1, 2]) {
      const asked = http.expectOne(
        (one) => one.method === 'POST' && one.url.endsWith('/documents'),
      );
      expect(asked.request.body).toMatchObject({
        url: `https://example.org/${n}`,
      });
      asked.flush({ outcome: 'duplicate', document: null, upload: null });
    }
    expect(sender.busy()).toBe(false);
    expect(sender.summary()).toMatchObject({ total: 2, already: 2 });
  });

  it('the list is read again by how many arrived, never by the progress of each', async () => {
    const { fixture } = await renderPage();
    const uploads = fixture.debugElement.injector.get(DocumentUploadsStore);
    const refresh = vi.spyOn(uploads, 'refresh');
    const sender = TestBed.inject(ContentSender) as unknown as {
      entries: WritableSignal<readonly ContentSend[]>;
    };
    const send = (key: number, phase: SendPhase): ContentSend => ({
      key,
      name: `a-${key}.pdf`,
      source: { kind: 'url', url: `https://example.org/${key}` },
      target: {
        topic: 'hermetismo',
        level: null,
        batch: { id: crypto.randomUUID(), capUsd: 0.5 },
      },
      phase,
    });
    for (let percent = 0; percent < 50; percent += 1) {
      sender.entries.set([
        send(1, { kind: 'sent' }),
        send(2, { kind: 'sending', percent }),
      ]);
      await fixture.whenStable();
    }
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('who may not create collections has no "Novo acervo"', async () => {
    await renderPage({ features: ['media', 'media-upload'] });
    expect(screen.queryByRole('button', { name: 'Novo acervo' })).toBeNull();
  });
});
