import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type { InviteProfile } from '@kb-chat/contracts';
import { TOPICS } from '../../testing/fixtures.js';
import { InviteProfilesPanel } from './invite-profiles-panel.js';
import { InviteProfilesStore } from './invite-profiles-store.js';
import { plainPreset } from './preset-defaults.js';

const URL = '/api/v1/invite-profiles';

const aluno: InviteProfile = {
  id: '44444444-4444-4444-8444-444444444444',
  name: 'Aluno',
  isDefault: true,
  preset: { ...plainPreset(), topics: ['hermetismo'] },
};
const pesquisador: InviteProfile = {
  ...aluno,
  id: '55555555-5555-4555-8555-555555555555',
  name: 'Pesquisador',
  isDefault: false,
};

async function renderPanel(profiles: InviteProfile[] = [aluno, pesquisador]) {
  const result = await render(InviteProfilesPanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      InviteProfilesStore,
    ],
    inputs: { topics: TOPICS.items, defaultAppAi: 'house' },
  });
  const http = TestBed.inject(HttpTestingController);
  TestBed.tick();
  http.expectOne(URL).flush({ items: profiles });
  await result.fixture.whenStable();
  host = result.fixture.nativeElement as HTMLElement;
  expect(toggle().getAttribute('aria-expanded')).toBe('false');
  openSection();
  await result.fixture.whenStable();
  return { ...result, http };
}

let host: HTMLElement;
/** The section starts folded (screens.md T9). */
const toggle = () => host.querySelector('#profiles-toggle') as HTMLElement;
const openSection = () => fireEvent.click(toggle());

const notice = () =>
  host.querySelector('.notice[aria-live="polite"]')?.textContent ?? '';

describe('InviteProfilesPanel (KBC-028 FR-2)', () => {
  it('lists the profiles with the default marked', async () => {
    await renderPanel();
    const list = screen.getByRole('list', { name: 'Perfis de convite' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]?.textContent).toContain('Padrão');
    expect(
      within(items[0] as HTMLElement).queryByRole('button', {
        name: /Tornar padrão/,
      }),
    ).toBeNull();
    expect(toggle().textContent).toMatch(/Perfis de convite\s*\(2\)/);
  });

  it('says there is none yet and offers to try again on a failed load', async () => {
    const result = await render(InviteProfilesPanel, {
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        InviteProfilesStore,
      ],
      inputs: { topics: TOPICS.items },
    });
    const http = TestBed.inject(HttpTestingController);
    http.expectOne(URL).flush({}, { status: 500, statusText: 'x' });
    await result.fixture.whenStable();
    host = result.fixture.nativeElement as HTMLElement;
    openSection();
    await result.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar os perfis.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    TestBed.tick();
    http.expectOne(URL).flush({ items: [] });
    await result.fixture.whenStable();
    expect(screen.getByText(/Nenhum perfil ainda/)).toBeTruthy();
  });

  it('creates a profile with its preset, and asks for a name first', async () => {
    const { http, fixture } = await renderPanel([]);
    fireEvent.click(screen.getByRole('button', { name: 'Novo perfil' }));
    await fixture.whenStable();
    const name = screen.getByLabelText('Nome do perfil');
    expect(document.activeElement).toBe(name);

    fireEvent.click(screen.getByRole('button', { name: 'Salvar perfil' }));
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Dê um nome ao perfil.',
    );
    http.expectNone(URL);

    fireEvent.input(name, { target: { value: ' Aluno ' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermetismo' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /padrão nos/ }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar perfil' }));
    const request = http.expectOne({ method: 'POST', url: URL });
    expect(request.request.body).toMatchObject({
      name: 'Aluno',
      isDefault: true,
      preset: { topics: ['hermetismo'], features: ['search'] },
    });
    request.flush(aluno);
    TestBed.tick();
    http.expectOne({ method: 'GET', url: URL }).flush({ items: [aluno] });
    await fixture.whenStable();
    expect(notice()).toContain('Perfil "Aluno" salvo.');
    expect(screen.queryByLabelText('Nome do perfil')).toBeNull();
  });

  it('edits and renames a profile, or cancels the edit', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Editar Pesquisador' }));
    await fixture.whenStable();
    const name = screen.getByLabelText('Nome do perfil') as HTMLInputElement;
    expect(name.value).toBe('Pesquisador');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(screen.queryByLabelText('Nome do perfil')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Editar Pesquisador' }));
    await fixture.whenStable();
    fireEvent.input(screen.getByLabelText('Nome do perfil'), {
      target: { value: 'Pesquisa' },
    });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Salvar perfil' }));
    const request = http.expectOne(`${URL}/${pesquisador.id}`);
    expect(request.request.method).toBe('PUT');
    expect(request.request.body).toMatchObject({ name: 'Pesquisa' });
    request.flush({ ...pesquisador, name: 'Pesquisa' });
    TestBed.tick();
    http.expectOne(URL).flush({ items: [aluno, pesquisador] });
    await fixture.whenStable();
    expect(notice()).toContain('Perfil "Pesquisa" salvo.');
  });

  it('starts the preset editor over for each profile, its notices included (KBC-033)', async () => {
    const { fixture } = await renderPanel();
    const cleared = /O acervo padrão foi limpo/;
    fireEvent.click(screen.getByRole('button', { name: 'Editar Aluno' }));
    await fixture.whenStable();
    fireEvent.change(screen.getByLabelText('Acervo padrão'), {
      target: { value: 'hermetismo' },
    });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermetismo' }));
    await fixture.whenStable();
    expect(screen.getByText(cleared)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Editar Pesquisador' }));
    await fixture.whenStable();
    expect(screen.queryByText(cleared)).toBeNull();
    // The next profile never inherits the last one's choice: its only collection is preselected.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermetismo' }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alquimia' }));
    await fixture.whenStable();
    expect(
      (screen.getByLabelText('Acervo padrão') as HTMLSelectElement).value,
    ).toBe('alquimia');
  });

  it('AC-3: marks another profile as the default', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(
      screen.getByRole('button', { name: 'Tornar padrão Pesquisador' }),
    );
    const request = http.expectOne(`${URL}/${pesquisador.id}`);
    expect(request.request.body).toEqual({ isDefault: true });
    request.flush({ ...pesquisador, isDefault: true });
    TestBed.tick();
    http.expectOne(URL).flush({
      items: [
        { ...aluno, isDefault: false },
        { ...pesquisador, isDefault: true },
      ],
    });
    await fixture.whenStable();
    expect(notice()).toContain('"Pesquisador" agora é o perfil padrão.');
    expect(
      screen.getByRole('button', { name: 'Tornar padrão Aluno' }),
    ).toBeTruthy();
  });

  it('deletes after a confirmation on the line, or keeps it', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Apagar Aluno' }));
    await fixture.whenStable();
    expect(screen.getByText(/Apagar o perfil "Aluno"\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(screen.queryByText(/Apagar o perfil "Aluno"\?/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Apagar Aluno' }));
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Apagar' }));
    const request = http.expectOne(`${URL}/${aluno.id}`);
    expect(request.request.method).toBe('DELETE');
    request.flush(null, { status: 204, statusText: 'No Content' });
    TestBed.tick();
    http.expectOne(URL).flush({ items: [pesquisador] });
    await fixture.whenStable();
    expect(notice()).toContain('Perfil "Aluno" apagado.');
  });

  it('shows a refused change as an error', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(
      screen.getByRole('button', { name: 'Tornar padrão Pesquisador' }),
    );
    http
      .expectOne(`${URL}/${pesquisador.id}`)
      .flush(
        { error: { code: 'FORBIDDEN', message: 'x' } },
        { status: 403, statusText: 'Forbidden' },
      );
    await fixture.whenStable();
    expect(host.querySelector('.notice.error')).toBeTruthy();
  });

  it('keeps keyboard focus on the line when deleting or making a default (WCAG 2.4.3)', async () => {
    const { http, fixture } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Apagar Aluno' }));
    await fixture.whenStable();
    expect(screen.getByText(/Ele é o padrão/)).toBeTruthy();
    expect(document.activeElement?.textContent?.trim()).toBe('Apagar');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Apagar Aluno' }),
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'Tornar padrão Pesquisador' }),
    );
    http
      .expectOne(`${URL}/${pesquisador.id}`)
      .flush({ ...pesquisador, isDefault: true });
    TestBed.tick();
    http.expectOne(URL).flush({
      items: [
        { ...aluno, isDefault: false },
        { ...pesquisador, isDefault: true },
      ],
    });
    await fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Editar Pesquisador' }),
    );
  });

  it('waits for a valid number before saving, and names the profile it edits', async () => {
    const { fixture } = await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: 'Editar Aluno' }));
    await fixture.whenStable();
    expect(screen.getByText('Editar o perfil "Aluno"')).toBeTruthy();
    fireEvent.change(
      screen.getByLabelText('Pesquisas por dia (vazio = padrão)'),
      { target: { value: '1.5' } },
    );
    await fixture.whenStable();
    expect(
      (
        screen.getByRole('button', {
          name: 'Salvar perfil',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
