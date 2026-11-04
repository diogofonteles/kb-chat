import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import type { TermList } from '@kb-chat/contracts';
import { TermsPanel } from './terms-panel.js';

const PROVIDERS = [
  provideZonelessChangeDetection(),
  provideHttpClient(),
  provideHttpClientTesting(),
];

const LIST: TermList = {
  version: 3,
  terms: ['Hoasca', 'Tiwaco'],
  tokens: 180,
  limit: 224,
  createdAt: '2026-10-28T12:00:00.000Z',
  authorName: 'Diogo',
  versions: [
    {
      version: 3,
      createdAt: '2026-10-28T12:00:00.000Z',
      authorName: 'Diogo',
      termCount: 2,
    },
    {
      version: 1,
      createdAt: '2026-10-20T12:00:00.000Z',
      authorName: null,
      termCount: 32,
    },
  ],
};

describe('TermsPanel (KBC-040)', () => {
  let fixture: ComponentFixture<TermsPanel>;
  let http: HttpTestingController;
  const text = () => (fixture.nativeElement as HTMLElement).textContent ?? '';

  function element<T extends HTMLElement = HTMLElement>(selector: string): T {
    const found = (fixture.nativeElement as HTMLElement).querySelector<T>(
      selector,
    );
    if (!found) throw new Error(`nothing matches ${selector}`);
    return found;
  }

  const button = (name: string): HTMLButtonElement => {
    const found = [
      ...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
    ].find(
      (one) =>
        one.textContent?.trim() === name ||
        one.getAttribute('aria-label') === name,
    );
    if (!found) throw new Error(`no button "${name}"`);
    return found;
  };

  const type = async (selector: string, value: string) => {
    const field = element<HTMLInputElement>(selector);
    field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await fixture.whenStable();
  };

  const add = async (value: string) => {
    await type('#terms-add', value);
    button('Adicionar').click();
    await fixture.whenStable();
  };

  /** Past the debounce: `tokens` is what the API answers for the draft. */
  async function measured(tokens: number) {
    await new Promise((resolve) => setTimeout(resolve, 320));
    http
      .expectOne('/api/v1/media/terms/measure')
      .flush({ tokens, limit: 224 });
    await fixture.whenStable();
  }

  const submit = async () => {
    button('Salvar lista').click();
    await fixture.whenStable();
  };

  beforeEach(async () => {
    ({ fixture } = await render(TermsPanel, { providers: PROVIDERS }));
    http = TestBed.inject(HttpTestingController);
    http.expectOne('/api/v1/media/terms').flush(LIST);
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    await fixture.whenStable();
  });

  afterEach(() => http.verify());

  it('FR-2: shows the use of the limit, the version and that nothing is redone alone', () => {
    expect(text()).toContain('180 de 224');
    expect(text()).toContain('Versão 3');
    expect(text()).toContain('só muda quando alguém pede "Transcrever de novo"');
    expect(text()).toContain('(lista inicial)');
  });

  it('AC-1: adds a pasted list and saves on the version it edited', async () => {
    await add('Tiuaco\nMariri\nhoasca\n');
    expect(text()).toContain('Termos repetidos ficam de fora: 1.');
    await measured(190);
    expect(text()).toContain('190 de 224');

    await submit();

    const saved = http.expectOne('/api/v1/media/terms');
    expect(saved.request.method).toBe('PUT');
    expect(saved.request.body).toEqual({
      baseVersion: 3,
      terms: ['Hoasca', 'Tiwaco', 'Tiuaco', 'Mariri'],
    });
    saved.flush({ ...LIST, version: 4, terms: saved.request.body.terms });
    await fixture.whenStable();
    expect(text()).toContain('Lista salva: versão 4.');
  });

  it('AC-3: refuses a list past the limit with the numbers, without calling save', async () => {
    await add('Muitos termos');
    await measured(231);
    const message =
      'A lista passou do limite do transcritor (231 de 224). Remova alguns termos.';
    expect(element('[role="alert"]').textContent).toContain(message);

    await submit();

    http.expectNone((request) => request.method === 'PUT');
  });

  it('AC-3: says the same when only the API found out', async () => {
    await add('Outro');
    await measured(200);
    await submit();
    http
      .expectOne('/api/v1/media/terms')
      .flush(
        {
          error: {
            code: 'TERMS_OVER_LIMIT',
            message: 'no',
            details: { tokens: 231, limit: 224 },
          },
        },
        { status: 422, statusText: 'Unprocessable' },
      );
    await fixture.whenStable();
    expect(text()).toContain('(231 de 224)');
  });

  it('removes a line, gives the focus to the next one and can discard the draft', async () => {
    button('Remover Hoasca').click();
    await fixture.whenStable();
    expect(document.activeElement?.id).toBe('term-1');
    await measured(170);

    button('Descartar mudanças').click();
    await fixture.whenStable();

    expect(element<HTMLInputElement>('#term-0').value).toBe('Hoasca');
  });

  it('marks a term the prompt cannot carry and does not save it', async () => {
    await type('#term-0', 'Hoasca, Mariri');
    expect(text()).toContain('Tire a vírgula');
    expect(element('#term-0').getAttribute('aria-invalid')).toBe('true');

    await submit();

    expect(text()).toContain('Corrija os termos marcados.');
  });

  it('says when nothing changed, and when the list would be empty', async () => {
    await submit();
    expect(text()).toContain('Nada mudou.');

    button('Remover Hoasca').click();
    await fixture.whenStable();
    await measured(170);
    button('Remover Tiwaco').click();
    await fixture.whenStable();
    await submit();
    expect(text()).toContain('A lista precisa de pelo menos um termo.');
  });

  it('keeps the draft when another master saved first, and reloads on request', async () => {
    await add('Tiuaco');
    await measured(190);
    await submit();
    http.expectOne('/api/v1/media/terms').flush(
      {
        error: {
          code: 'MEDIA_CONFLICT',
          message: 'no',
          details: { reason: 'terms-changed', version: 5 },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();
    expect(text()).toContain('Outra pessoa mudou a lista (versão 5).');
    expect(element<HTMLInputElement>('#term-2').value).toBe('Tiuaco');

    button('Recarregar').click();
    TestBed.tick();
    http.expectOne('/api/v1/media/terms').flush({ ...LIST, version: 5 });
    await fixture.whenStable();
    expect(text()).toContain('Versão 5');
  });
});

describe('TermsPanel while it cannot load', () => {
  it('offers to try again', async () => {
    const { fixture } = await render(TermsPanel, { providers: PROVIDERS });
    const http = TestBed.inject(HttpTestingController);
    http
      .expectOne('/api/v1/media/terms')
      .flush('no', { status: 500, statusText: 'Error' });
    await fixture.whenStable();
    expect(fixture.nativeElement.textContent).toContain(
      'Não foi possível carregar a lista.',
    );
  });
});
