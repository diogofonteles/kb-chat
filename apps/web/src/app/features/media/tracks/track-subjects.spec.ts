import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { LOCALE_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { Feature, TrackSubjects as Track } from '@kb-chat/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionStore } from '@core/auth/session-store.js';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { TrackSubjects } from './track-subjects.js';

const ID = '11111111-1111-4111-8111-111111111111';
const TRACK = '22222222-2222-4222-8222-222222222222';
const FREE = '33333333-3333-4333-8333-333333333333';
const SUGGESTION = '44444444-4444-4444-8444-444444444444';
const SECOND = '55555555-5555-4555-8555-555555555555';
const STEP = `/api/v1/media/${ID}/edit/subjects`;
const COLLECTION = '/api/v1/topics/hermetismo/subjects';
const PROPOSALS = `/api/v1/media/${ID}/edit/subject-proposals`;
const WRITE = `/api/v1/media/${TRACK}/subjects`;

const aTrack = (overrides: Partial<Track> = {}): Track => ({
  mediaId: TRACK,
  title: 'Como o senhor chegou lá?',
  ordinal: 1,
  version: 2,
  summary: null,
  subjects: [],
  suggestions: [],
  suggestedSummary: null,
  ...overrides,
});

const concept = (name: string, missing = false) => ({
  kind: 'concept' as const,
  name,
  id: null,
  missing,
});

const ESTIMATE = {
  estimateUsd: 0.004,
  runCapUsd: 0.25,
  windows: 1,
  model: 'stub',
  allowed: true,
  refusal: null,
  month: null,
};

const aRun = (status: string, failure: string | null = null) => ({
  id: FREE,
  mediaId: ID,
  status,
  model: 'stub',
  estimateUsd: 0.004,
  spentUsd: 0.003,
  failure,
  createdAt: '2026-11-04T05:00:00.000Z',
  finishedAt: null,
});

interface Opening {
  readonly tracks?: readonly Track[];
  readonly run?: object | null;
  readonly canSuggest?: boolean;
  readonly features?: readonly Feature[];
}

let opened: HttpTestingController | null = null;

/** A reload may stay pending, and `whenStable` would wait for it: one task and a render. */
async function settled(): Promise<void> {
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
}

async function setup(opening: Opening = {}) {
  const features = signal<readonly Feature[]>(
    opening.features ?? ['media-classify', 'media-edit-ai'],
  );
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: LOCALE_ID, useValue: 'en-US' },
      { provide: MEDIA_POLL_MS, useValue: 100_000 },
      {
        provide: SessionStore,
        useValue: { can: (feature: Feature) => features().includes(feature) },
      },
    ],
  });
  const fixture = TestBed.createComponent(TrackSubjects);
  fixture.componentRef.setInput('mediaId', ID);
  fixture.componentRef.setInput('topic', 'hermetismo');
  const http = TestBed.inject(HttpTestingController);
  opened = http;
  TestBed.tick();
  http.expectOne(STEP).flush({
    tracks: opening.tracks ?? [aTrack()],
    run: opening.run ?? null,
    canSuggest: opening.canSuggest ?? true,
  });
  http.expectOne(COLLECTION).flush({
    concepts: ['Cabala', 'Ritmo'],
    free: [{ id: FREE, name: 'Burracheira' }],
  });
  await settled();
  const root = fixture.nativeElement as HTMLElement;
  const button = (name: string) =>
    [...root.querySelectorAll('button')].find(
      (one) =>
        one.getAttribute('aria-label') === name ||
        one.textContent?.trim() === name,
    );
  const stable = settled;
  return { fixture, http, root, button, stable };
}

const fieldOf = (root: HTMLElement) => {
  const field = root.querySelector<HTMLInputElement>('input[role=combobox]');
  if (!field) throw new Error('no field');
  return field;
};

const type = (root: HTMLElement, text: string) => {
  const field = root.querySelector<HTMLInputElement>('input[role=combobox]');
  if (!field) throw new Error('no field');
  field.value = text;
  field.dispatchEvent(new Event('focus'));
  field.dispatchEvent(new Event('input'));
};

const pick = (root: HTMLElement, label: string) => {
  const option = [...root.querySelectorAll('[role=option]')].find(
    (one) => one.textContent?.trim() === label,
  );
  if (!option) throw new Error(`no option ${label}`);
  option.dispatchEvent(new MouseEvent('mousedown', { cancelable: true }));
};

afterEach(() => {
  opened?.verify();
  opened = null;
});

describe('Assuntos, step 4 (KBC-069)', () => {
  it('shows the empty state and the suggestion, with no chip accepted', async () => {
    const { root, button } = await setup();
    expect(root.textContent).toContain('Nenhum assunto ainda');
    expect(button('Sugerir assuntos com IA')).toBeTruthy();
  });

  it('AC-6: no suggestion without media-edit-ai', async () => {
    const { button, root } = await setup({ features: ['media-classify'] });
    expect(button('Sugerir assuntos com IA')).toBeUndefined();
    expect(root.querySelector('input[role=combobox]')).toBeTruthy();
  });

  it('adds a concept through the field, naming the version read', async () => {
    const { root, http, stable } = await setup();
    type(root, 'cab');
    await stable();
    pick(root, 'Cabala');
    const put = http.expectOne(WRITE);
    expect(put.request.headers.get('If-Match')).toBe('"2"');
    expect(put.request.body).toEqual({
      subjects: [{ kind: 'concept', name: 'Cabala' }],
      summary: null,
    });
    put.flush(aTrack({ version: 3, subjects: [concept('Cabala')] }));
    await stable();
    expect(
      root.querySelector('[aria-label="Remover assunto Cabala"]'),
    ).toBeTruthy();
  });

  it('NG-30: gives the focus back to the field when the add ends, saved or refused', async () => {
    const { fixture, root, http, stable } = await setup();
    document.body.append(root);
    const field = fieldOf(root);
    field.focus();
    type(root, 'cab');
    await stable();
    pick(root, 'Cabala');
    // A browser drops the focus of a field that gets disabled.
    field.blur();
    await stable();
    http
      .expectOne(WRITE)
      .flush(aTrack({ version: 3, subjects: [concept('Cabala')] }));
    await stable();
    expect(document.activeElement).toBe(field);

    type(root, 'ritm');
    await stable();
    pick(root, 'Ritmo');
    field.blur();
    await stable();
    http
      .expectOne(WRITE)
      .flush(
        { error: { code: 'MEDIA_CONFLICT' } },
        { status: 409, statusText: 'Conflict' },
      );
    await stable();
    expect(document.activeElement).toBe(field);
    fixture.destroy();
    root.remove();
  });

  it('does not offer what the track has, nor to create what exists without accent', async () => {
    const { root, stable } = await setup({
      tracks: [aTrack({ subjects: [concept('Cabala')] })],
    });
    type(root, 'cabalá');
    await stable();
    expect(root.querySelector('[role=option]')).toBeNull();
    type(root, 'burrachéira');
    await stable();
    expect(root.textContent).not.toContain('Criar assunto');
    expect(root.querySelector('[role=option]')?.textContent?.trim()).toBe(
      'Burracheira',
    );
  });

  it('creates a new free subject and links it', async () => {
    const { root, http, stable } = await setup();
    type(root, 'Sete Raios');
    await stable();
    pick(root, 'Criar assunto «Sete Raios»');
    const post = http.expectOne(COLLECTION);
    expect(post.request.body).toEqual({ name: 'Sete Raios' });
    post.flush({ id: SECOND, name: 'Sete Raios' });
    const put = http.expectOne(WRITE);
    expect(put.request.body).toMatchObject({
      subjects: [{ kind: 'free', id: SECOND }],
    });
    put.flush(aTrack({ version: 3 }));
    await stable();
    http
      .expectOne(COLLECTION)
      .flush({ concepts: [], free: [{ id: SECOND, name: 'Sete Raios' }] });
    await stable();
  });

  it('AC-4: says a repeated subject exists', async () => {
    const { root, http, stable } = await setup();
    type(root, 'Outro');
    await stable();
    pick(root, 'Criar assunto «Outro»');
    http.expectOne(COLLECTION).flush(
      {
        error: {
          code: 'MEDIA_CONFLICT',
          message: 'x',
          details: { reason: 'duplicate-subject' },
        },
      },
      { status: 409, statusText: 'Conflict' },
    );
    await stable();
    http
      .expectOne(COLLECTION)
      .flush({ concepts: [], free: [{ id: SECOND, name: 'Outro' }] });
    await stable();
    expect(root.textContent).toContain('Este assunto já existe');
  });

  it('AC-3: refuses a sixth subject on the screen, with no request', async () => {
    const five = ['A', 'B', 'C', 'D', 'E'].map((name) => concept(name));
    const { root, stable } = await setup({
      tracks: [aTrack({ subjects: five })],
    });
    type(root, 'Cabala');
    await stable();
    pick(root, 'Cabala');
    await stable();
    expect(root.querySelector('[role=alert]')?.textContent).toContain(
      'Até 5 assuntos por faixa',
    );
  });

  it('AC-3: refuses accepting all past five', async () => {
    const four = ['A', 'B', 'C', 'D'].map((name) => concept(name));
    const suggestions = [
      { id: SUGGESTION, kind: 'concept' as const, name: 'Cabala' },
      { id: SECOND, kind: 'concept' as const, name: 'Ritmo' },
    ];
    const { root, button, stable } = await setup({
      tracks: [aTrack({ subjects: four, suggestions })],
    });
    button('Aceitar todas as sugestões desta faixa')?.click();
    await stable();
    expect(root.textContent).toContain('Até 5 assuntos por faixa');
  });

  it('FR-4, AC-9: names each chip, and accepting sends the decision', async () => {
    const { root, button, http, stable } = await setup({
      tracks: [
        aTrack({
          suggestions: [
            { id: SUGGESTION, kind: 'concept', name: 'Cabala' },
            { id: SECOND, kind: 'new', name: 'Sete Raios' },
          ],
        }),
      ],
    });
    expect(root.textContent).toContain('Sugerido');
    expect(root.textContent).toContain('Novo assunto: «Sete Raios»');
    expect(button('Recusar sugestão Cabala')).toBeTruthy();
    button('Aceitar sugestão Cabala')?.click();
    const post = http.expectOne(`${WRITE}/decisions`);
    expect(post.request.body).toEqual({
      accept: [SUGGESTION],
      refuse: [],
      summary: null,
    });
    post.flush(aTrack({ version: 3, subjects: [concept('Cabala')] }));
    await stable();
    expect(button('Aceitar sugestão Cabala')).toBeUndefined();
  });

  it('accepts a whole track, summary included', async () => {
    const { button, http } = await setup({
      tracks: [
        aTrack({
          suggestions: [{ id: SUGGESTION, kind: 'concept', name: 'Cabala' }],
          suggestedSummary: 'Um resumo.',
        }),
      ],
    });
    button('Aceitar todas as sugestões desta faixa')?.click();
    const post = http.expectOne(`${WRITE}/decisions`);
    expect(post.request.body).toEqual({
      accept: [SUGGESTION],
      refuse: [],
      summary: 'accept',
    });
    post.flush(aTrack({ version: 3 }));
  });

  it('saves the summary when it changed, and only then', async () => {
    const { root, http } = await setup({
      tracks: [aTrack({ summary: 'Antes' })],
    });
    const area = root.querySelector('textarea');
    if (!area) throw new Error('no summary');
    area.dispatchEvent(new Event('change'));
    http.expectNone(WRITE);
    area.value = ' Depois ';
    area.dispatchEvent(new Event('change'));
    const put = http.expectOne(WRITE);
    expect(put.request.body).toEqual({ subjects: [], summary: 'Depois' });
    put.flush(aTrack({ version: 3, summary: 'Depois' }));
  });

  it('AC-5: says a subject left the collection', async () => {
    const { root } = await setup({
      tracks: [aTrack({ subjects: [concept('Cabala', true)] })],
    });
    expect(root.textContent).toContain('Assunto não encontrado no acervo');
  });

  it('reloads when someone else changed the track', async () => {
    const { root, http, stable } = await setup();
    type(root, 'cab');
    await stable();
    pick(root, 'Cabala');
    http
      .expectOne(WRITE)
      .flush(
        { error: { code: 'EDIT_STALE', message: 'x' } },
        { status: 412, statusText: 'Precondition Failed' },
      );
    await stable();
    http
      .expectOne(STEP)
      .flush({ tracks: [aTrack({ version: 5 })], run: null, canSuggest: true });
    await stable();
    expect(root.querySelector('[role=alert]')).toBeTruthy();
  });

  it('shows the price first, and spends only on the confirmation', async () => {
    const { root, button, http, stable } = await setup();
    button('Sugerir assuntos com IA')?.click();
    const dry = http.expectOne(PROPOSALS);
    expect(dry.request.body).toEqual({ dryRun: true });
    dry.flush(ESTIMATE);
    await stable();
    expect(root.textContent).toContain('Custa cerca de $0.004');
    button('Confirmar e sugerir')?.click();
    const run = http.expectOne(PROPOSALS);
    expect(run.request.body).toEqual({ dryRun: false });
    run.flush(aRun('running'));
    await stable();
    http
      .expectOne(STEP)
      .flush({ tracks: [aTrack()], run: aRun('running'), canSuggest: false });
    await stable();
    expect(root.textContent).toContain('Sugerindo assuntos…');
  });

  it('cancels without spending', async () => {
    const { button, http, stable, root } = await setup();
    button('Sugerir assuntos com IA')?.click();
    http.expectOne(PROPOSALS).flush(ESTIMATE);
    await stable();
    button('Cancelar')?.click();
    await stable();
    expect(root.textContent).not.toContain('Custa cerca de');
  });

  it('AC-7: says the monthly cap stopped it and offers no confirmation', async () => {
    const { root, button, http, stable } = await setup();
    button('Sugerir assuntos com IA')?.click();
    http.expectOne(PROPOSALS).flush({
      ...ESTIMATE,
      allowed: false,
      refusal: 'monthly-cap',
    });
    await stable();
    expect(root.textContent).toContain('O teto mensal da mídia foi atingido.');
    expect(button('Confirmar e sugerir')).toBeUndefined();
  });

  it('says why a run failed and offers to try again by a press', async () => {
    const { root, button } = await setup({
      run: aRun('failed', 'invalid-output'),
    });
    expect(root.textContent).toContain('Não foi possível sugerir.');
    expect(root.textContent).toContain('A resposta da IA veio ilegível.');
    expect(button('Tentar de novo')).toBeTruthy();
  });

  it('shows what a finished run cost and no way to run it again', async () => {
    const { root, button } = await setup({
      run: aRun('done'),
      canSuggest: false,
    });
    expect(root.textContent).toContain('Custou $0.003');
    expect(button('Sugerir assuntos com IA')).toBeUndefined();
  });
});
