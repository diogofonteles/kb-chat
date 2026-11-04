import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { Feature, PreparationOptions as Offer } from '@kb-chat/contracts';
import { sessionAs } from '../../../testing/media-fixtures.js';
import { anOffer } from '../../../testing/preparation-fixtures.js';
import { PlanForm } from './plan-form.js';
import { PreparationOptions } from './preparation-options.js';

async function renderOptions(
  offer: Offer = anOffer(),
  features: Feature[] = [
    'media',
    'media-upload',
    'media-edit',
    'media-edit-ai',
  ],
) {
  const view = await render(PreparationOptions, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      sessionAs({ features }),
      PlanForm,
    ],
  });
  TestBed.inject(PlanForm).aim({ durationMs: 3_720_000 });
  TestBed.tick();
  const http = TestBed.inject(HttpTestingController);
  http
    .match((request) =>
      request.url.startsWith('/api/v1/media/preparation-options'),
    )
    .forEach((request) => {
      if (!request.cancelled) request.flush(offer);
    });
  await view.fixture.whenStable();
  return { ...view, form: TestBed.inject(PlanForm) };
}

const box = (name: string | RegExp) =>
  screen.getByRole<HTMLInputElement>('checkbox', { name });
const radio = (name: string | RegExp) =>
  screen.getByRole<HTMLInputElement>('radio', { name });

describe('PreparationOptions (T20, step 1)', () => {
  beforeEach(() => localStorage.clear());

  it('comes with the free options ticked and "Não dividir agora" (AC-1)', async () => {
    await renderOptions();
    expect(box('Transcrever').checked).toBe(true);
    expect(box('Indicar quem está falando').checked).toBe(true);
    expect(radio('Não dividir agora').checked).toBe(true);
    expect(radio('Propor as faixas com IA').checked).toBe(false);
  });

  it('keeps an option off focusable, with the reason in words (AC-1, BR-3)', async () => {
    await renderOptions(
      anOffer({
        options: {
          ...anOffer().options,
          ai: { done: false, refusal: 'permission', minutes: null },
        },
        aiEstimateUsd: null,
        monthRemainingUsd: null,
      }),
      ['media', 'media-upload', 'media-edit'],
    );
    const ai = radio('Propor as faixas com IA');
    expect(ai.disabled).toBe(false);
    expect(ai.getAttribute('aria-disabled')).toBe('true');
    expect(ai.getAttribute('aria-describedby')).toBe('prep-ai-hint');
    expect(screen.getByText(/Você não tem permissão para isto/)).toBeTruthy();
  });

  it('does nothing on a press of an option off', async () => {
    const { fixture, form } = await renderOptions(
      anOffer({
        options: {
          ...anOffer().options,
          ai: { done: false, refusal: 'monthly-cap', minutes: null },
        },
      }),
    );
    fireEvent.click(radio('Propor as faixas com IA'));
    await fixture.whenStable();
    expect(form.choices().tracks).toBe('none');
  });

  it('shows the cost and what is left, and puts the value in the summary (AC-3)', async () => {
    const { fixture, form } = await renderOptions();
    fireEvent.click(radio('Propor as faixas com IA'));
    await fixture.whenStable();
    expect(
      screen.getByText(/US\$\s0,02, descontado do limite mensal/),
    ).toBeTruthy();
    expect(screen.getByText(/restam US\$\s8,40/)).toBeTruthy();
    const summary = screen.getByTestId('plan-summary').textContent;
    expect(summary).toContain('propor faixas com IA');
    expect(summary).toContain('≈ 7 min');
    expect(summary).toMatch(/US\$\s0,02/);
    expect(summary).toContain('você valida as faixas');
    expect(form.plan().acceptedUsd).toBe(0.02);
  });

  it('unticking "Transcrever" unticks and turns off the rest, with the warning (AC-2)', async () => {
    const { fixture, form } = await renderOptions();
    fireEvent.click(radio('Vou marcar as faixas eu mesmo'));
    await fixture.whenStable();
    fireEvent.click(box('Transcrever'));
    await fixture.whenStable();
    expect(box('Indicar quem está falando').checked).toBe(false);
    expect(radio('Vou marcar as faixas eu mesmo').checked).toBe(false);
    expect(
      radio('Vou marcar as faixas eu mesmo').getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen.getByText(
        'Sem a transcrição não dá para indicar quem fala nem dividir em faixas.',
      ),
    ).toBeTruthy();
    expect(form.guided()).toBe(false);
    expect(screen.getByTestId('plan-summary').textContent).toContain(
      'só guardar o áudio',
    );
  });

  it('warns of the transcriber off, without turning the option off (UP-02)', async () => {
    await renderOptions(
      anOffer({
        transcriber: 'off',
        transcriberOffSince: '2026-11-02T22:10:00.000Z',
      }),
    );
    expect(screen.getByText(/O transcritor está desligado desde/)).toBeTruthy();
    expect(box('Transcrever').getAttribute('aria-disabled')).toBeNull();
  });

  it('shows the subjects off, with the reason', async () => {
    await renderOptions();
    expect(
      box('Sugerir os assuntos de cada faixa').getAttribute('aria-disabled'),
    ).toBe('true');
    expect(
      screen.getByText('Ainda não está disponível nesta versão.'),
    ).toBeTruthy();
  });

  it('leaves out what the recording already has (AC-16)', async () => {
    const options = anOffer().options;
    await renderOptions(
      anOffer({
        options: {
          ...options,
          transcribe: { ...options.transcribe, done: true },
        },
      }),
    );
    expect(screen.queryByRole('checkbox', { name: 'Transcrever' })).toBeNull();
  });

  it('has no paid option without a value to show (BR-4)', async () => {
    const { fixture, form } = await renderOptions(
      anOffer({ aiEstimateUsd: null }),
    );
    fireEvent.click(radio('Propor as faixas com IA'));
    await fixture.whenStable();
    expect(form.choices().tracks).toBe('none');
  });
});
