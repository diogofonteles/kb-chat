import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ActivatedRoute,
  convertToParamMap,
  provideRouter,
} from '@angular/router';
import type { Me, TopicLevels, UnassignedPage } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { of } from 'rxjs';
import { SessionStore } from '@core/auth/session-store.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { aMe, anOwner } from '../../testing/session-fixtures.js';
import { LevelsPage } from './levels-page.js';
import { answeringUnassigned, unassignedPage } from './unassigned-fixtures.js';

const URL = '/api/v1/topics/hermetismo/levels';

const level = (
  id: string,
  code: string,
  counts: { documents: number; people: number; media?: number } = {
    documents: 0,
    people: 0,
  },
) => ({ id, code, description: '', media: 0, ...counts });

const scale = (over: Partial<TopicLevels> = {}): TopicLevels => ({
  collection: 'hermetismo',
  inherited: false,
  levels: [],
  documents: 6,
  people: 2,
  unassigned: 0,
  version: 'v1',
  ...over,
});

const noImpact = { people: 0, documents: 0, media: 0 };

const THREE = scale({
  levels: [
    level('qs', 'QS', { documents: 4, people: 2 }),
    level('ci', 'CI', { documents: 1, people: 0 }),
    level('cdc', 'CDC', { documents: 1, people: 0 }),
  ],
});

async function open(
  slug = 'hermetismo',
  answer: TopicLevels | 'fails' = scale(),
  {
    me = { ...anOwner(), features: [...anOwner().features, 'content-levels'] },
    queue = unassignedPage({ count: 0 }),
  }: { me?: Me; queue?: UnassignedPage } = {},
) {
  const rendered = await render(LevelsPage, {
    providers: [
      { provide: SessionStore, useValue: { me: signal(me) } },
      provideZonelessChangeDetection(),
      provideHttpClient(withInterceptors([answeringUnassigned(queue)])),
      provideHttpClientTesting(),
      provideRouter([]),
      {
        provide: ActivatedRoute,
        useValue: { paramMap: of(convertToParamMap({ slug })) },
      },
      {
        provide: ChatStore,
        useValue: {
          topicList: signal([
            { slug: 'hermetismo', title: 'Hermetismo' },
            { slug: 'hermetismo/aulas', title: 'Aulas' },
          ]),
          topic: signal(null),
        },
      },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  TestBed.tick();
  if (!me.levelsManager) {
    await rendered.fixture.whenStable();
    return { ...rendered, http };
  }
  const url = `/api/v1/topics/${encodeURIComponent(slug)}/levels`;
  const request = http.expectOne(url);
  if (answer === 'fails') request.flush('', { status: 500, statusText: 'x' });
  else request.flush(answer);
  await rendered.fixture.whenStable();
  return { ...rendered, http };
}

const codeBox = () => screen.getByRole('textbox', { name: 'Código' });

describe('LevelsPage (T24, KBC-103)', () => {
  it('says a collection without levels shows everything, and asks before the first level', async () => {
    const { fixture, http } = await open();
    expect(
      screen.getByText(
        'Este acervo não tem níveis. Todos com acesso veem todo o conteúdo.',
      ),
    ).toBeTruthy();
    fireEvent.input(codeBox(), { target: { value: 'QS' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }));
    await fixture.whenStable();
    http.expectNone(URL);
    expect(screen.getByText(/Todos os 6 documentos/)).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Criar nível' });
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    const created = http.expectOne({ method: 'POST', url: URL });
    expect(created.request.body).toEqual({ code: 'QS', description: '' });
    created.flush(
      scale({ levels: [level('qs', 'QS', { documents: 6, people: 2 })] }),
    );
    await fixture.whenStable();
    expect(screen.getByText('6 documentos · 2 pessoas')).toBeTruthy();
    expect(screen.getByText('Nível QS criado.')).toBeTruthy();
  });

  it('AC-11: a taken code is said in the field, keeping what was typed', async () => {
    const { fixture, http } = await open('hermetismo', THREE);
    fireEvent.input(codeBox(), { target: { value: 'ci' } });
    fireEvent.click(screen.getByRole('button', { name: 'Adicionar' }));
    http.expectOne({ method: 'POST', url: URL }).flush(
      {
        error: {
          code: 'LEVEL_CODE_TAKEN',
          message: 'x',
          details: { code: 'CI' },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'Já existe um nível com o código CI.',
    );
    expect(codeBox().getAttribute('aria-invalid')).toBe('true');
    expect((codeBox() as HTMLInputElement).value).toBe('ci');
  });

  it('AC-12, KBC-108 AC-3: moves a level after the server counts who gains and loses, and announces its new place', async () => {
    const { fixture, http } = await open('hermetismo', THREE);
    expect(
      (
        screen.getByRole('button', {
          name: 'Mover para cima: QS',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Mover para baixo: CI' }),
    );
    await fixture.whenStable();
    const confirm = screen.getByRole('button', { name: 'Confirmar' });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    const preview = http.expectOne({ method: 'POST', url: `${URL}/preview` });
    expect(preview.request.body).toEqual({
      order: ['qs', 'cdc', 'ci'],
      version: 'v1',
    });
    preview.flush({
      version: 'v1',
      gaining: { people: 2, documents: 12, media: 2 },
      losing: { people: 1, documents: 6, media: 0 },
      removal: null,
      profiles: 0,
    });
    await fixture.whenStable();
    expect(
      screen.getByText(
        'Mover CI para a 3ª posição? 2 pessoas passam a ver 14 itens; 1 pessoa deixa de ver 6 itens.',
      ),
    ).toBeTruthy();
    expect(document.activeElement).toBe(confirm);
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    const moved = http.expectOne({ method: 'PATCH', url: URL });
    expect(moved.request.body).toEqual({
      order: ['qs', 'cdc', 'ci'],
      version: 'v1',
    });
    moved.flush(
      scale({
        levels: [level('qs', 'QS'), level('cdc', 'CDC'), level('ci', 'CI')],
        version: 'v2',
      }),
    );
    await fixture.whenStable();
    expect(screen.getByText('CI agora é o 3º de 3')).toBeTruthy();
  });

  it('KBC-108 BR-3: a scale changed since the preview says so and is read again', async () => {
    const { fixture, http } = await open('hermetismo', THREE);
    fireEvent.click(
      screen.getByRole('button', { name: 'Mover para cima: CDC' }),
    );
    http.expectOne({ method: 'POST', url: `${URL}/preview` }).flush({
      version: 'v1',
      gaining: noImpact,
      losing: noImpact,
      removal: null,
      profiles: 0,
    });
    await fixture.whenStable();
    expect(
      screen.getByText(
        'Mover CDC para a 2ª posição? Ninguém ganha nem perde acesso.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    http
      .expectOne({ method: 'PATCH', url: URL })
      .flush(
        { error: { code: 'LEVELS_CHANGED', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    TestBed.tick();
    http.expectOne({ method: 'GET', url: URL }).flush(THREE);
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'A escala mudou. Confira de novo.',
    );
  });

  it('R1-13: the failure of a move replaced meanwhile leaves the current one alone', async () => {
    const { fixture, http } = await open('hermetismo', THREE);
    fireEvent.click(
      screen.getByRole('button', { name: 'Mover para baixo: CI' }),
    );
    const first = http.expectOne({ method: 'POST', url: `${URL}/preview` });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: 'Mover para cima: CDC' }),
    );
    const second = http.match({ method: 'POST', url: `${URL}/preview` });
    first.flush('', { status: 500, statusText: 'x' });
    await fixture.whenStable();
    expect(screen.queryByRole('alert')).toBeNull();
    second.at(-1)?.flush({
      version: 'v1',
      gaining: noImpact,
      losing: noImpact,
      removal: null,
      profiles: 0,
    });
    await fixture.whenStable();
    expect(
      screen.getByText(
        'Mover CDC para a 2ª posição? Ninguém ganha nem perde acesso.',
      ),
    ).toBeTruthy();
  });

  it('shows the audios of a level next to its documents and people', async () => {
    await open(
      'hermetismo',
      scale({
        levels: [level('qs', 'QS', { documents: 4, people: 2, media: 1 })],
      }),
    );
    expect(screen.getByText('4 documentos · 1 áudio · 2 pessoas')).toBeTruthy();
  });

  it('AC-11: renames a level in place', async () => {
    const { fixture, http } = await open('hermetismo', THREE);
    fireEvent.click(screen.getByRole('button', { name: 'Renomear CI' }));
    await fixture.whenStable();
    const [renameBox] = screen.getAllByRole('textbox', { name: 'Código' });
    if (!renameBox) throw new Error('no rename box');
    expect(document.activeElement).toBe(renameBox);
    fireEvent.input(renameBox, { target: { value: 'C.I.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    const renamed = http.expectOne({ method: 'PATCH', url: `${URL}/ci` });
    expect(renamed.request.body).toEqual({ code: 'C.I.', description: '' });
    renamed.flush(
      scale({
        levels: [level('qs', 'QS'), level('ci', 'C.I.'), level('cdc', 'CDC')],
      }),
    );
    await fixture.whenStable();
    expect(screen.getByText('C.I.')).toBeTruthy();
  });

  it('KBC-107: lists the documents without a level below the scale', async () => {
    const { fixture } = await open(
      'hermetismo',
      scale({ ...THREE, unassigned: 1 }),
      { queue: unassignedPage({ count: 1 }) },
    );
    await fixture.whenStable();
    expect(screen.getByRole('heading', { name: 'Sem nível (1)' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Novo 0' })).toBeTruthy();
  });

  it('KBC-107 D3: whoever classifies (not a master) sees only "Sem nível", never the scale', async () => {
    const { http } = await open('hermetismo', scale(), {
      me: aMe({ features: ['search', 'content-levels'] }),
    });
    http.expectNone(URL);
    expect(screen.getByText('Todos os documentos têm nível.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Adicionar' })).toBeNull();
  });

  it('BR-1: a sub-collection points to its parent levels', async () => {
    await open('hermetismo/aulas', scale({ ...THREE, inherited: true }));
    expect(screen.getByText(/Este sub-acervo usa os níveis de/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Hermetismo' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Adicionar' })).toBeNull();
  });

  it('offers to try again when the scale does not load', async () => {
    const { fixture, http } = await open('hermetismo', 'fails');
    expect(
      screen.getByText('Não consegui carregar os níveis deste acervo.'),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    TestBed.tick();
    http.expectOne(URL).flush(THREE);
    await fixture.whenStable();
    expect(screen.getByText('CDC')).toBeTruthy();
  });
});
