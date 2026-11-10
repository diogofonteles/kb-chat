import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { ContentLevel } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { DocumentLevel } from './document-level.js';

const SCALE = {
  collection: 'hermetismo',
  inherited: false,
  levels: [
    { id: 'qs', code: 'QS', description: '', documents: 4, people: 1 },
    { id: 'ci', code: 'CI', description: '', documents: 2, people: 1 },
  ],
  documents: 7,
  people: 2,
  unassigned: 1,
};

async function renderLevel(level: ContentLevel) {
  const view = await render(DocumentLevel, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
    inputs: { topic: 'hermetismo', documentId: 'raw/novo.md', level },
  });
  return { ...view, http: TestBed.inject(HttpTestingController) };
}

describe('DocumentLevel (T3, KBC-103 FR-4, AC-9)', () => {
  it('says "Sem nível" in text, and saves the level chosen', async () => {
    const { fixture, http } = await renderLevel(null);
    expect(screen.getByText('Sem nível')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mudar nível' }));
    TestBed.tick();
    http.expectOne('/api/v1/topics/hermetismo/levels').flush(SCALE);
    await fixture.whenStable();
    fireEvent.change(screen.getByRole('combobox', { name: 'Nível' }), {
      target: { value: 'ci' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    const saved = http.expectOne({
      method: 'PUT',
      url: '/api/v1/topics/hermetismo/documents/raw%2Fnovo.md/level',
    });
    expect(saved.request.body).toEqual({ level: 'ci' });
    saved.flush({ level: { id: 'ci', code: 'CI' } });
    await fixture.whenStable();
    expect(screen.getByText('Nível: CI')).toBeTruthy();
    expect(screen.getByText('Nível salvo: CI.')).toBeTruthy();
  });

  it('says why a save failed', async () => {
    const { fixture, http } = await renderLevel({ id: 'qs', code: 'QS' });
    fireEvent.click(screen.getByRole('button', { name: 'Mudar nível' }));
    TestBed.tick();
    http.expectOne('/api/v1/topics/hermetismo/levels').flush(SCALE);
    await fixture.whenStable();
    fireEvent.change(screen.getByRole('combobox', { name: 'Nível' }), {
      target: { value: 'ci' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar' }));
    http
      .expectOne({ method: 'PUT' })
      .flush('', { status: 500, statusText: 'x' });
    await fixture.whenStable();
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText('Nível: QS')).toBeTruthy();
  });
});
