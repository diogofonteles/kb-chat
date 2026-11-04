import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { TrackAboutView } from './track-about-view.js';

const ID = '6f1c2b9b-8a11-4d0a-9d55-0b6f1f0e6a3e';
const ABOUT = {
  subjects: [{ key: 'concept:cabala', name: 'Cabala' }],
  summary: 'Uma pergunta sobre a Cabala.',
};

async function renderView(canSearch: boolean, body: object | null = ABOUT) {
  const chosen: string[] = [];
  const view = await render(TrackAboutView, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
    ],
    inputs: { mediaId: ID, canSearch },
    on: { subjectChosen: (name: string) => chosen.push(name) },
  });
  const call = TestBed.inject(HttpTestingController).expectOne(
    `/api/v1/media/${ID}/about`,
  );
  if (body) call.flush(body);
  else call.flush('no', { status: 500, statusText: 'Error' });
  await view.fixture.whenStable();
  return chosen;
}

describe('TrackAboutView (KBC-070)', () => {
  it('shows the subjects and the summary, and a chip asks for the search', async () => {
    const chosen = await renderView(true);
    expect(screen.getByText('Uma pergunta sobre a Cabala.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Buscar por Cabala' }));
    expect(chosen).toEqual(['Cabala']);
  });

  it('keeps the chip as text for who may not search', async () => {
    await renderView(false);
    expect(screen.getByText('Cabala')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows nothing when there is nothing to say, or the read fails', async () => {
    await renderView(true, { subjects: [], summary: null });
    expect(screen.queryByText('Assuntos:')).toBeNull();
  });

  it('leaves the page as it was when the read fails', async () => {
    await renderView(true, null);
    expect(screen.queryByText('Assuntos:')).toBeNull();
  });
});
