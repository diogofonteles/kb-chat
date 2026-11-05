import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { VoiceProfileForm } from './voice-profile-form.js';

const PROFILES = '/api/v1/topics/udv/voice-profiles';
const SPEAKERS = '/api/v1/topics/udv/speakers';
const SPEAKER = '00000000-0000-4000-8000-000000000001';
const TAKEN = '00000000-0000-4000-8000-000000000009';
const MEDIA = '00000000-0000-4000-8000-000000000002';
const VOICES = `/api/v1/topics/udv/speakers/${SPEAKER}/named-voices`;
const aSpeaker = (id: string, name: string) => ({
  id,
  name,
  authorSlug: null,
  main: false,
});

/** Lets a resource take a flushed answer and ask what depends on it. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve));
  TestBed.tick();
  await new Promise((resolve) => setTimeout(resolve));
};

async function renderForm(taken: readonly string[] = []) {
  const created = vi.fn();
  const result = await render(VoiceProfileForm, {
    inputs: { topic: 'udv', taken },
    on: { created },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(SPEAKERS).flush({
    items: [aSpeaker(SPEAKER, 'Gabriel'), aSpeaker(TAKEN, 'Já tem perfil')],
  });
  await result.fixture.whenStable();
  return { ...result, http, created };
}

const type = (label: string | RegExp, value: string) =>
  fireEvent.input(screen.getByLabelText(label), { target: { value } });

function fillConsent(): void {
  fireEvent.change(screen.getByLabelText('Pessoa'), {
    target: { value: SPEAKER },
  });
  type('Quem autorizou', 'Gabriel da Costa');
  fireEvent.input(screen.getByLabelText('Data da autorização'), {
    target: { value: '2026-10-01' },
  });
  fireEvent.click(screen.getByLabelText('Colar o texto do aceite'));
}

const proceed = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Continuar' }));

async function toSources(view: Awaited<ReturnType<typeof renderForm>>) {
  fillConsent();
  await view.fixture.whenStable();
  type('Texto do aceite', 'Autorizo o uso da minha voz.');
  fireEvent.click(screen.getByRole('checkbox', { name: /Confirmo/ }));
  proceed();
  await settle();
  view.http.expectOne(VOICES).flush({
    items: [
      { mediaId: MEDIA, title: 'Palestra', voice: 2, speakingMs: 45_000 },
    ],
  });
  await view.fixture.whenStable();
}

describe('VoiceProfileForm (KBC-071 AC-1, BR-1)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('leaves out who already has a profile, with the confirmation unchecked', async () => {
    await renderForm([TAKEN]);
    expect(screen.queryByRole('option', { name: 'Já tem perfil' })).toBeNull();
    const box = screen.getByRole<HTMLInputElement>('checkbox', {
      name: /Confirmo/,
    });
    expect(box.checked).toBe(false);
  });

  it('shows the finality, the keeping and how to revoke before asking anything', async () => {
    await renderForm();
    for (const part of [/Finalidade única/, /Guarda:/, /Revogação:/])
      expect(screen.getByText(part)).toBeTruthy();
    expect(screen.getByText(/Colha a assinatura neste texto/)).toBeTruthy();
    expect(screen.queryByText(/revisão jurídica/)).toBeNull();
  });

  it('asks for what is missing, one thing at a time, and shows no voice', async () => {
    const view = await renderForm();
    proceed();
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Escolha a pessoa.',
    );
    fillConsent();
    await view.fixture.whenStable();
    proceed();
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Anexe o documento ou cole o texto do aceite.',
    );
    type('Texto do aceite', 'Autorizo o uso da minha voz.');
    proceed();
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Confirme a autorização para continuar.',
    );
    expect(screen.queryByText('De quais vozes calcular')).toBeNull();
  });

  it('a deceased person needs who answers for the work, and in what capacity', async () => {
    const view = await renderForm();
    fireEvent.click(screen.getByLabelText('Pessoa falecida'));
    await view.fixture.whenStable();
    expect(
      screen.getByText(/Autorização de quem responde pela obra/),
    ).toBeTruthy();
    fillConsentForDeceased();
    await view.fixture.whenStable();
    proceed();
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Preencha os campos do consentimento.',
    );
    expect(screen.getByLabelText(/Em que qualidade/)).toBeTruthy();
  });

  it('refuses a file that is not a document, in words', async () => {
    const view = await renderForm();
    const file = new File(['x'], 'a.txt', { type: 'text/plain' });
    fireEvent.change(screen.getByLabelText(/^Documento/), {
      target: { files: [file] },
    });
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'Use um PDF, JPEG ou PNG de até 5 MB.',
    );
  });

  it('needs enough speech, then sends the consent with the voices', async () => {
    const view = await renderForm();
    await toSources(view);
    const save = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Calcular perfil',
    });
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/Palestra, Voz 2/));
    await view.fixture.whenStable();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await view.fixture.whenStable();
    const sent = view.http.expectOne(PROFILES);
    expect(sent.request.body).toMatchObject({
      speakerId: SPEAKER,
      sources: [{ mediaId: MEDIA, voice: 2 }],
      consent: {
        subject: 'living',
        grantedBy: 'Gabriel da Costa',
        grantedByRole: null,
        grantedOn: '2026-10-01',
        method: 'signed-paper',
        purpose: 'suggest-names-when-editing',
        textVersion: 2,
        evidence: { kind: 'text', text: 'Autorizo o uso da minha voz.' },
      },
    });
    sent.flush({
      id: MEDIA,
      speakerId: SPEAKER,
      speakerName: 'Gabriel',
      status: 'calculating',
      sourceCount: 1,
      grantedBy: 'Gabriel da Costa',
      grantedOn: '2026-10-01',
      createdAt: '2026-11-04T10:00:00.000Z',
    });
    await view.fixture.whenStable();
    expect(view.created).toHaveBeenCalledOnce();
  });

  it('a consent the API refuses goes back to the consent', async () => {
    const view = await renderForm();
    await toSources(view);
    fireEvent.click(screen.getByLabelText(/Palestra, Voz 2/));
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Calcular perfil' }));
    await view.fixture.whenStable();
    view.http.expectOne(PROFILES).flush({}, { status: 422, statusText: 'x' });
    await view.fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'O consentimento não foi aceito.',
    );
    expect(screen.getByText('Consentimento específico')).toBeTruthy();
  });

  it('with the list lost it says so, not that the person has a profile', async () => {
    const view = await renderForm();
    await toSources(view);
    fireEvent.click(screen.getByLabelText(/Palestra, Voz 2/));
    await view.fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Calcular perfil' }));
    await view.fixture.whenStable();
    view.http
      .expectOne(PROFILES)
      .flush(
        { error: { code: 'VOICE_LIST_LOST', message: 'x' } },
        { status: 409, statusText: 'x' },
      );
    await view.fixture.whenStable();
    const alert = screen.getByRole('alert').textContent;
    expect(alert).toContain('lista de revogações');
    expect(alert).not.toContain('já tem um perfil');
  });

  it('says so when a speaker has no named voice yet', async () => {
    const view = await renderForm();
    fillConsent();
    await view.fixture.whenStable();
    type('Texto do aceite', 'Autorizo o uso da minha voz.');
    fireEvent.click(screen.getByRole('checkbox', { name: /Confirmo/ }));
    proceed();
    await settle();
    view.http.expectOne(VOICES).flush({ items: [] });
    await view.fixture.whenStable();
    expect(screen.getByText(/ainda não tem voz nomeada/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Voltar ao consentimento' }),
    );
    await view.fixture.whenStable();
    expect(screen.getByText('Consentimento específico')).toBeTruthy();
  });
});

function fillConsentForDeceased(): void {
  fireEvent.change(screen.getByLabelText('Pessoa'), {
    target: { value: SPEAKER },
  });
  type(/Quem responde pela obra/, 'Instituição');
  fireEvent.input(screen.getByLabelText('Data da autorização'), {
    target: { value: '2026-10-01' },
  });
}
