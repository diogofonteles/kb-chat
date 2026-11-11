import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { LevelPreview, TopicLevels } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { LevelDeleteDialog } from './level-delete-dialog.js';

const URL = '/api/v1/topics/hermetismo/levels';

const level = (id: string, code: string) => ({
  id,
  code,
  description: '',
  documents: 0,
  media: 0,
  people: 0,
});

const scaleOf = (levels: TopicLevels['levels']): TopicLevels => ({
  collection: 'hermetismo',
  inherited: false,
  levels,
  documents: 15,
  people: 4,
  unassigned: 0,
  version: 'v1',
});

const THREE = scaleOf([
  level('qs', 'QS'),
  { ...level('ci', 'CI'), documents: 12, media: 3, people: 4 },
  level('cdc', 'CDC'),
]);

const CI_PREVIEW: LevelPreview = {
  version: 'v1',
  gaining: { people: 0, documents: 0, media: 0 },
  losing: { people: 4, documents: 12, media: 3 },
  removal: {
    level: { id: 'ci', code: 'CI' },
    documents: 12,
    media: 3,
    people: 4,
    moveContentTo: 'cdc',
    movePeopleTo: 'qs',
    last: false,
  },
};

async function dialogFor(scale: TopicLevels) {
  const done = vi.fn();
  const stale = vi.fn();
  const rendered = await render(LevelDeleteDialog, {
    inputs: { topic: 'hermetismo', title: 'Hermetismo', scale },
    on: { done, stale },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const dialog = rendered.fixture.componentInstance;
  return { ...rendered, http, dialog, done, stale };
}

const selectOf = (name: string) =>
  screen.getByRole('combobox', { name }) as HTMLSelectElement;

describe('LevelDeleteDialog (T24, KBC-108)', () => {
  it('AC-1, AC-8: names what the level holds, with the default targets before the danger button, which takes the focus', async () => {
    const { fixture, http, dialog, done } = await dialogFor(THREE);
    const ci = THREE.levels[1];
    if (!ci) throw new Error('no CI');
    dialog.openFor(ci);
    await fixture.whenStable();
    const asked = http.expectOne({ method: 'POST', url: `${URL}/preview` });
    expect(asked.request.body).toEqual({ remove: 'ci', version: 'v1' });
    asked.flush(CI_PREVIEW);
    await fixture.whenStable();
    expect(
      screen.getByText('12 documentos, 3 áudios e 4 pessoas estão em CI.'),
    ).toBeTruthy();
    expect(selectOf('Conteúdo de CI vai para:').value).toBe('cdc');
    expect(selectOf('Pessoas em CI vão para:').value).toBe('qs');
    const confirm = screen.getByRole('button', { name: 'Apagar CI' });
    expect(document.activeElement).toBe(confirm);
    const people = selectOf('Pessoas em CI vão para:');
    expect(
      people.compareDocumentPosition(confirm) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    fireEvent.change(people, { target: { value: 'cdc' } });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    const removed = http.expectOne({ method: 'DELETE', url: `${URL}/ci` });
    expect(removed.request.body).toEqual({
      moveContentTo: 'cdc',
      movePeopleTo: 'cdc',
      version: 'v1',
    });
    const after = scaleOf([level('qs', 'QS'), level('cdc', 'CDC')]);
    removed.flush(after);
    await fixture.whenStable();
    expect(done).toHaveBeenCalledWith(after);
    http.verify();
  });

  it('BR-3: a scale changed since the preview says so, keeps the choices and asks for a reload', async () => {
    const { fixture, http, dialog, stale } = await dialogFor(THREE);
    const ci = THREE.levels[1];
    if (!ci) throw new Error('no CI');
    dialog.openFor(ci);
    http.expectOne(`${URL}/preview`).flush(CI_PREVIEW);
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Apagar CI' }));
    http
      .expectOne({ method: 'DELETE', url: `${URL}/ci` })
      .flush(
        { error: { code: 'LEVELS_CHANGED', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent?.trim()).toBe(
      'A escala mudou. Confira de novo.',
    );
    expect(selectOf('Conteúdo de CI vai para:').value).toBe('cdc');
    expect(stale).toHaveBeenCalled();
  });

  it('AC-4: "Tirar todos os níveis" stays disabled until the collection name is typed', async () => {
    const { fixture, http, dialog, done } = await dialogFor(THREE);
    dialog.openForAll();
    await fixture.whenStable();
    expect(
      screen.getByText(
        'Todos com acesso ao acervo passam a ver todo o conteúdo.',
      ),
    ).toBeTruthy();
    const name = screen.getByRole('textbox', {
      name: /Digite o nome do acervo para confirmar/,
    });
    expect(document.activeElement).toBe(name);
    const confirm = screen.getByRole('button', {
      name: 'Tirar todos os níveis',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.input(name, { target: { value: 'Hermetism' } });
    await fixture.whenStable();
    expect(confirm.disabled).toBe(true);
    fireEvent.input(name, { target: { value: '  hermetismo ' } });
    await fixture.whenStable();
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    const cleared = http.expectOne({ method: 'DELETE', url: URL });
    expect(cleared.request.body).toEqual({
      confirm: 'hermetismo',
      version: 'v1',
    });
    cleared.flush(scaleOf([]));
    await fixture.whenStable();
    expect(done).toHaveBeenCalled();
  });

  it('AC-6: the only level opens as "Tirar todos os níveis", with no preview', async () => {
    const one = scaleOf([level('qs', 'QS')]);
    const { fixture, http, dialog } = await dialogFor(one);
    const qs = one.levels[0];
    if (!qs) throw new Error('no QS');
    dialog.openFor(qs);
    await fixture.whenStable();
    http.expectNone(`${URL}/preview`);
    expect(
      screen.getByRole('heading', { name: 'Tirar todos os níveis' }),
    ).toBeTruthy();
  });

  it('says when the preview cannot be made, and never deletes without it', async () => {
    const { fixture, http, dialog } = await dialogFor(THREE);
    const ci = THREE.levels[1];
    if (!ci) throw new Error('no CI');
    dialog.openFor(ci);
    http
      .expectOne(`${URL}/preview`)
      .flush('', { status: 500, statusText: 'x' });
    await fixture.whenStable();
    expect(screen.getByRole('alert')).toBeTruthy();
    const confirm = screen.getByRole('button', {
      name: 'Apagar CI',
    }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
  });
});
