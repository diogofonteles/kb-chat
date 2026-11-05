import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type {
  MediaPreparation,
  MediaSpeakers,
  VoiceSuggestion,
} from '@kb-chat/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  MEDIA_ID,
  aPreparation,
} from '../../../testing/preparation-fixtures.js';
import { PreparationVoices } from './preparation-voices.js';

const SPEAKER = '33333333-3333-4333-8333-333333333333';
const VOICES = `/api/v1/media/${MEDIA_ID}/voices`;
const SPEAKERS = '/api/v1/topics/hermetismo/speakers';
const AUTHORS = '/api/v1/topics/hermetismo/authors';
const WRONG: VoiceSuggestion = {
  voice: 1,
  name: 'Márcio da Roça',
  audience: false,
  reason: 'se apresenta',
};

const ANSWER: MediaSpeakers = {
  mediaId: MEDIA_ID,
  status: 'done',
  transcriber: 'on',
  transcriberOffSince: null,
  canRequest: true,
  diarization: null,
  voiceSuggestions: [],
};

const wait = () => new Promise((resolve) => setTimeout(resolve));

const voice = (over: object = {}) => ({
  voice: 1,
  speakingMs: 60_000,
  name: null,
  audience: false,
  ...over,
});

async function setup(over: Partial<MediaPreparation> = {}) {
  const named = vi.fn();
  const rendered = await render(PreparationVoices, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
    inputs: {
      preparation: aPreparation({
        separation: 2,
        author: null,
        voices: [voice()],
        suggestions: [WRONG],
        ...over,
      }),
    },
    on: { named },
  });
  const http = TestBed.inject(HttpTestingController);
  /** Opens the field and answers the lists it offers. */
  const correct = async (name = /Corrigir/) => {
    fireEvent.click(screen.getByRole('button', { name }));
    TestBed.tick();
    await wait();
    http.expectOne(SPEAKERS).flush({ items: [] });
    http.expectOne(AUTHORS).flush({ items: [] });
    await rendered.fixture.whenStable();
    return screen.getByRole<HTMLInputElement>('combobox');
  };
  return { ...rendered, http, named, correct };
}

describe('PreparationVoices (KBC-090)', () => {
  it('accepts the name as it is, once for two presses', async () => {
    const { http, named, fixture } = await setup();
    const accept = screen.getByRole('button', {
      name: 'Aceitar Márcio da Roça para a Voz 1',
    });
    fireEvent.click(accept);
    fireEvent.click(accept);
    http.expectOne(SPEAKERS).flush({
      id: SPEAKER,
      name: 'Márcio da Roça',
      authorSlug: null,
      main: false,
    });
    http.expectOne(`${VOICES}/1`).flush(ANSWER);
    await fixture.whenStable();
    expect(named).toHaveBeenCalled();
  });

  it('corrects the name in the field, already filled in, and that accepts it', async () => {
    const { http, fixture, correct } = await setup();
    const field = await correct();
    expect(field.value).toBe('Márcio da Roça');
    expect(document.activeElement).toBe(field);
    fireEvent.input(field, { target: { value: 'Márcio da Rós' } });
    await fixture.whenStable();
    fireEvent.keyDown(field, { key: 'Enter' });
    await fixture.whenStable();
    const create = http.expectOne(SPEAKERS);
    expect(create.request.body).toEqual({ name: 'Márcio da Rós' });
    create.flush({
      id: SPEAKER,
      name: 'Márcio da Rós',
      authorSlug: null,
      main: false,
    });
    const put = http.expectOne(`${VOICES}/1`);
    expect(put.request.body).toEqual({
      version: 2,
      speakerId: SPEAKER,
      audience: false,
    });
  });

  it('brings the focus back to the row once the name is in', async () => {
    const { http, fixture, correct } = await setup();
    const field = await correct();
    fireEvent.input(field, { target: { value: 'Márcio da Rós' } });
    await fixture.whenStable();
    fireEvent.keyDown(field, { key: 'Enter' });
    await fixture.whenStable();
    http.expectOne(SPEAKERS).flush({
      id: SPEAKER,
      name: 'Márcio da Rós',
      authorSlug: null,
      main: false,
    });
    http.expectOne(`${VOICES}/1`).flush(ANSWER);
    await fixture.whenStable();
    await wait();
    expect(document.activeElement?.getAttribute('data-voice')).toBe('1');
  });

  it('refuses the name: the suggestion leaves and nobody is named', async () => {
    const { http, named, fixture } = await setup();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Recusar o nome sugerido para a Voz 1',
      }),
    );
    const refuse = http.expectOne(`${VOICES}/1/refuse-name`);
    expect(refuse.request.body).toEqual({ version: 2 });
    refuse.flush(ANSWER);
    await fixture.whenStable();
    expect(named).toHaveBeenCalled();
    expect(screen.queryByText(/parece ser/)).toBeNull();
  });

  it('still corrects a voice that was accepted with a wrong name', async () => {
    const { correct } = await setup({
      voices: [voice({ name: 'Márcio da Roça' })],
      suggestions: [],
    });
    const field = await correct(/Corrigir o nome da Voz 1/);
    expect(field.value).toBe('Márcio da Roça');
  });

  it('gives a name to a voice nobody named', async () => {
    const { correct } = await setup({ suggestions: [] });
    const field = await correct(/Dar nome à Voz 1/);
    expect(field.value).toBe('');
  });

  it('cancels with the focus back on the row', async () => {
    const { correct, fixture } = await setup();
    await correct();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    await wait();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.activeElement?.textContent).toContain('Corrigir');
  });

  it('does not suggest the author again for a voice whose name was refused', async () => {
    await setup({
      author: 'Mestre Gabriel',
      suggestions: [],
      refusedVoices: [1],
    });
    expect(screen.queryByText(/parece ser/)).toBeNull();
  });

  it('says what went wrong and keeps the offer', async () => {
    const { http, fixture } = await setup();
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Recusar o nome sugerido para a Voz 1',
      }),
    );
    http
      .expectOne(`${VOICES}/1/refuse-name`)
      .flush(
        { error: { code: 'MEDIA_CONFLICT', message: 'x' } },
        { status: 409, statusText: 'x' },
      );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent?.length).toBeGreaterThan(0);
    expect(screen.getByText(/parece ser/)).toBeTruthy();
  });
});
