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
  profiles: 0,
};

const ALL_PREVIEW: LevelPreview = {
  version: 'v1',
  gaining: { people: 4, documents: 12, media: 3 },
  losing: { people: 0, documents: 0, media: 0 },
  removal: null,
  profiles: 0,
};

async function dialogFor(scale: TopicLevels) {
  const done = vi.fn();
  const stale = vi.fn();
  const gone = vi.fn();
  const rendered = await render(LevelDeleteDialog, {
    inputs: { topic: 'hermetismo', title: 'Hermetismo', scale },
    on: { done, stale, gone },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  const dialog = rendered.fixture.componentInstance;
  return { ...rendered, http, dialog, done, stale, gone };
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

  it('KBC-109: says that the invite profiles using the level will ask for another one', async () => {
    const { fixture, http, dialog } = await dialogFor(THREE);
    const ci = THREE.levels[1];
    if (!ci) throw new Error('no CI');
    dialog.openFor(ci);
    http.expectOne(`${URL}/preview`).flush({ ...CI_PREVIEW, profiles: 2 });
    await fixture.whenStable();
    expect(
      screen.getByText(
        '2 perfis de convite usam CI. Eles não mudam: ao aplicá-los, a pessoa fica no nível mais baixo até alguém escolher outro no perfil.',
      ),
    ).toBeTruthy();
  });

  it('BR-3, R1-2: after a 409 the dialog reads the scale, counts again on it and confirms only on the new preview', async () => {
    const { fixture, http, dialog, stale } = await dialogFor(THREE);
    const ci = THREE.levels[1];
    if (!ci) throw new Error('no CI');
    dialog.openFor(ci);
    http.expectOne(`${URL}/preview`).flush(CI_PREVIEW);
    await fixture.whenStable();
    const confirm = screen.getByRole('button', {
      name: 'Apagar CI',
    }) as HTMLButtonElement;
    fireEvent.click(confirm);
    http
      .expectOne({ method: 'DELETE', url: `${URL}/ci` })
      .flush(
        { error: { code: 'LEVELS_CHANGED', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    expect(stale).toHaveBeenCalled();
    // Another master moved CI to the top: the people's default is now CDC.
    const reordered = {
      ...scaleOf([level('qs', 'QS'), level('cdc', 'CDC'), level('ci', 'CI')]),
      version: 'v2',
    };
    http.expectOne({ method: 'GET', url: URL }).flush(reordered);
    await fixture.whenStable();
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);
    http.expectNone({ method: 'DELETE', url: `${URL}/ci` });
    const again = http.expectOne({ method: 'POST', url: `${URL}/preview` });
    expect(again.request.body).toEqual({ remove: 'ci', version: 'v2' });
    const removal = CI_PREVIEW.removal;
    if (!removal) throw new Error('no removal');
    again.flush({
      ...CI_PREVIEW,
      version: 'v2',
      removal: { ...removal, moveContentTo: 'cdc', movePeopleTo: 'cdc' },
    });
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent?.trim()).toBe(
      'A escala mudou. Contei de novo com a escala de agora: confira antes de confirmar.',
    );
    expect(selectOf('Pessoas em CI vão para:').value).toBe('cdc');
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    const removed = http.expectOne({ method: 'DELETE', url: `${URL}/ci` });
    expect(removed.request.body).toEqual({
      moveContentTo: 'cdc',
      movePeopleTo: 'cdc',
      version: 'v2',
    });
  });

  it('BR-3, R2-3: a level deleted by someone else meanwhile closes the dialog and says which', async () => {
    const { fixture, http, dialog, gone } = await dialogFor(THREE);
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
    http.expectOne({ method: 'GET', url: URL }).flush({
      ...scaleOf([level('qs', 'QS'), level('cdc', 'CDC')]),
      version: 'v2',
    });
    await fixture.whenStable();
    expect(screen.queryByRole('dialog')).toBeNull();
    http.expectNone(`${URL}/preview`);
    expect(gone).toHaveBeenCalledWith('CI');
  });

  it('R2-2: an answer for a level the dialog no longer shows is never its preview', async () => {
    const { fixture, http, dialog } = await dialogFor(THREE);
    const [qs, ci] = THREE.levels;
    if (!qs || !ci) throw new Error('no levels');
    dialog.openFor(qs);
    const first = http.expectOne({ method: 'POST', url: `${URL}/preview` });
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    dialog.openFor(ci);
    expect(first.cancelled).toBe(true);
    const second = http.expectOne({ method: 'POST', url: `${URL}/preview` });
    expect(second.request.body).toEqual({ remove: 'ci', version: 'v1' });
    second.flush(CI_PREVIEW);
    await fixture.whenStable();
    expect(
      screen.getByText('12 documentos, 3 áudios e 4 pessoas estão em CI.'),
    ).toBeTruthy();
  });

  it('QA-r2-2: counting again for every level keeps the focus on the name, during and after', async () => {
    const { fixture, http, dialog } = await dialogFor(THREE);
    dialog.openForAll();
    http.expectOne(`${URL}/preview`).flush(ALL_PREVIEW);
    await fixture.whenStable();
    const name = screen.getByRole('textbox', {
      name: /Digite o nome do acervo para confirmar/,
    });
    fireEvent.input(name, { target: { value: 'Hermetismo' } });
    await fixture.whenStable();
    const confirm = screen.getByRole('button', {
      name: 'Tirar todos os níveis',
    });
    confirm.focus();
    fireEvent.click(confirm);
    http
      .expectOne({ method: 'DELETE', url: URL })
      .flush(
        { error: { code: 'LEVELS_CHANGED', message: 'x' } },
        { status: 409, statusText: 'Conflict' },
      );
    http
      .expectOne({ method: 'GET', url: URL })
      .flush({ ...THREE, version: 'v2' });
    TestBed.tick();
    expect(document.activeElement).toBe(name);
    http.expectOne(`${URL}/preview`).flush({ ...ALL_PREVIEW, version: 'v2' });
    await fixture.whenStable();
    expect(document.activeElement).toBe(name);
  });

  it('QA-r2-2: a dialog that becomes "Tirar todos" (one level left) puts the focus on the name', async () => {
    const { fixture, http, dialog } = await dialogFor(THREE);
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
    http
      .expectOne({ method: 'GET', url: URL })
      .flush({ ...scaleOf([level('ci', 'CI')]), version: 'v2' });
    TestBed.tick();
    const asked = http.expectOne(`${URL}/preview`);
    expect(asked.request.body).toEqual({ all: true, version: 'v2' });
    asked.flush({ ...ALL_PREVIEW, version: 'v2' });
    await fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByRole('textbox', {
        name: /Digite o nome do acervo para confirmar/,
      }),
    );
  });

  it('AC-4: "Tirar todos os níveis" stays disabled until the collection name is typed', async () => {
    const { fixture, http, dialog, done } = await dialogFor(THREE);
    dialog.openForAll();
    const asked = http.expectOne({ method: 'POST', url: `${URL}/preview` });
    expect(asked.request.body).toEqual({ all: true, version: 'v1' });
    asked.flush({ ...ALL_PREVIEW, profiles: 1 });
    await fixture.whenStable();
    expect(
      screen.getByText(
        '1 perfil de convite usa um nível deste acervo. Ele não muda: ao aplicá-lo, o nível dele não vale mais.',
      ),
    ).toBeTruthy();
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

  it('AC-6: the only level opens as "Tirar todos os níveis", with its preview', async () => {
    const one = scaleOf([level('qs', 'QS')]);
    const { fixture, http, dialog } = await dialogFor(one);
    const qs = one.levels[0];
    if (!qs) throw new Error('no QS');
    dialog.openFor(qs);
    const asked = http.expectOne({ method: 'POST', url: `${URL}/preview` });
    expect(asked.request.body).toEqual({ all: true, version: 'v1' });
    asked.flush(ALL_PREVIEW);
    await fixture.whenStable();
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
