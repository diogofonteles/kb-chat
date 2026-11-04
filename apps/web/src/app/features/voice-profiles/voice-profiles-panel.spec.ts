import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type {
  VoiceConsentEntry,
  VoiceProfile,
  VoiceProfileList,
} from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { VoiceProfilesPanel } from './voice-profiles-panel.js';

const TOPICS = '/api/v1/topics';
const PROFILES = '/api/v1/topics/udv/voice-profiles';
const REPORT = '/api/v1/voice-profiles/report';
const SPEAKERS = '/api/v1/topics/udv/speakers';
const SPEAKER = '00000000-0000-4000-8000-000000000001';
const ID = '00000000-0000-4000-8000-000000000002';

const aTopic = (slug: string, parent: string | null = null) => ({
  slug,
  title: slug.toUpperCase(),
  documentCount: 0,
  parent,
});

const aProfile = (overrides: Partial<VoiceProfile> = {}): VoiceProfile => ({
  id: ID,
  speakerId: SPEAKER,
  speakerName: 'Mestre Gabriel',
  status: 'ready',
  sourceCount: 2,
  grantedBy: 'Gabriel da Costa',
  grantedOn: '2026-10-01',
  createdAt: '2026-11-04T10:00:00.000Z',
  ...overrides,
});

const aListOf = (items: VoiceProfile[]): VoiceProfileList => ({
  items,
  transcriber: 'on',
});

const anEntry = (
  overrides: Partial<VoiceConsentEntry> = {},
): VoiceConsentEntry => ({
  id: ID,
  speakerName: 'Mestre Gabriel',
  collection: 'udv',
  subject: 'living',
  grantedBy: 'Gabriel da Costa',
  grantedByRole: null,
  grantedOn: '2026-10-01',
  method: 'signed-paper',
  purpose: 'suggest-names-when-editing',
  textVersion: 1,
  registeredBy: 'dono@example.com',
  registeredAt: '2026-11-04T10:00:00.000Z',
  evidence: 'text',
  revokedAt: null,
  revokedBy: null,
  suggestions: { made: 4, accepted: 2, refused: 1 },
  ...overrides,
});

async function renderPanel(input: {
  list?: VoiceProfileList;
  owner?: boolean;
  entries?: VoiceConsentEntry[];
}) {
  const me = signal({ isOwner: input.owner ?? false });
  const result = await render(VoiceProfilesPanel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: SessionStore, useValue: { me } },
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(TOPICS).flush({
    items: [aTopic('udv'), aTopic('udv/sub', 'udv')],
    defaultSlug: null,
  });
  await result.fixture.whenStable();
  http.expectOne(PROFILES).flush(input.list ?? aListOf([]));
  if (input.owner) http.expectOne(REPORT).flush({ items: input.entries ?? [] });
  await result.fixture.whenStable();
  return { ...result, http };
}

describe('VoiceProfilesPanel (KBC-071)', () => {
  afterEach(() => TestBed.inject(HttpTestingController).verify());

  it('says when a collection has no profile, and offers only top-level collections', async () => {
    await renderPanel({});
    expect(screen.getByText('Nenhum perfil neste acervo.')).toBeTruthy();
    expect(screen.queryByRole('option', { name: 'UDV/SUB' })).toBeNull();
  });

  it('says when no transcriber handles profiles', async () => {
    await renderPanel({ list: { items: [], transcriber: 'none' } });
    expect(
      screen.getByText(/Nenhum transcritor ligado trata perfis de voz/),
    ).toBeTruthy();
  });

  it('shows who authorised, and the state in words', async () => {
    await renderPanel({ list: aListOf([aProfile()]) });
    expect(screen.getByText('Mestre Gabriel')).toBeTruthy();
    expect(screen.getByText('Pronto')).toBeTruthy();
    expect(
      screen.getByText(/Autorizado por Gabriel da Costa em 01\/10\/2026/),
    ).toBeTruthy();
  });

  it('never shows a score or a print', async () => {
    await renderPanel({ list: aListOf([aProfile()]) });
    expect(document.body.textContent).not.toMatch(/embedding|0\.\d{3}/);
  });

  it('offers to calculate again when a profile has no print', async () => {
    const { http, fixture } = await renderPanel({
      list: aListOf([aProfile({ status: 'failed' })]),
    });
    expect(screen.getByText('Precisa calcular de novo')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Calcular de novo' }));
    await fixture.whenStable();
    http
      .expectOne(`/api/v1/voice-profiles/${ID}/recalculate`)
      .flush(aProfile({ status: 'calculating' }));
    http.expectOne(PROFILES).flush(aListOf([]));
    await fixture.whenStable();
  });

  it('asks before revoking, with the focus on the safe answer', async () => {
    const { fixture } = await renderPanel({ list: aListOf([aProfile()]) });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Revogar o consentimento de Mestre Gabriel',
      }),
    );
    await fixture.whenStable();
    expect(screen.getByText(/Os nomes já confirmados/)).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Cancelar' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(screen.queryByText(/Os nomes já confirmados/)).toBeNull();
  });

  it('revokes, says so and reads the list again', async () => {
    const { http, fixture } = await renderPanel({
      list: aListOf([aProfile()]),
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Revogar o consentimento de Mestre Gabriel',
      }),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar e apagar' }));
    await fixture.whenStable();
    const sent = http.expectOne(`/api/v1/voice-profiles/${ID}`);
    expect(sent.request.method).toBe('DELETE');
    sent.flush(null);
    http.expectOne(PROFILES).flush(aListOf([]));
    await fixture.whenStable();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Consentimento revogado',
    );
  });

  it('keeps the question open when revoking fails', async () => {
    const { http, fixture } = await renderPanel({
      list: aListOf([aProfile()]),
    });
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Revogar o consentimento de Mestre Gabriel',
      }),
    );
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Revogar e apagar' }));
    await fixture.whenStable();
    http
      .expectOne(`/api/v1/voice-profiles/${ID}`)
      .flush({}, { status: 500, statusText: 'x' });
    http.expectOne(PROFILES).flush(aListOf([aProfile()]));
    await fixture.whenStable();
    expect(screen.getByRole('alert')).toHaveTextContent('Não consegui revogar');
    expect(screen.getByText(/Os nomes já confirmados/)).toBeTruthy();
  });

  it('shows no report to a master who is not the owner', async () => {
    await renderPanel({ owner: false });
    expect(screen.queryByText('Perfis e consentimentos')).toBeNull();
  });

  it('AC-8: shows the owner each consent, the revocation and the counts', async () => {
    await renderPanel({
      owner: true,
      entries: [
        anEntry({
          revokedAt: '2026-11-04T12:00:00.000Z',
          revokedBy: 'dono@example.com',
        }),
      ],
    });
    expect(screen.getByText('Perfis e consentimentos')).toBeTruthy();
    expect(screen.getByText(/Revogado em 04\/11\/2026/)).toBeTruthy();
    expect(screen.getByText('Documento assinado em papel')).toBeTruthy();
    expect(
      screen.getByText(/4 feitas,\s+2 aceitas,\s+1 recusadas/),
    ).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Baixar a prova do consentimento' }),
    ).toHaveAttribute('href', `/api/v1/voice-consents/${ID}/evidence`);
  });

  it('AC-1: asks for the consent before any voice', async () => {
    const { http, fixture } = await renderPanel({});
    fireEvent.click(screen.getByRole('button', { name: 'Cadastrar perfil' }));
    await fixture.whenStable();
    http.expectOne(SPEAKERS).flush({
      items: [{ id: SPEAKER, name: 'Gabriel', authorSlug: null, main: false }],
    });
    await fixture.whenStable();
    expect(screen.getByText('Consentimento específico')).toBeTruthy();
    expect(screen.queryByText('De quais vozes calcular')).toBeNull();
  });
});
