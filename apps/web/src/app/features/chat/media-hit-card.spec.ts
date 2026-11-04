import { provideZonelessChangeDetection } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import { aMediaHit } from '../../testing/fixtures.js';
import { MediaHitCard } from './media-hit-card.js';

const renderHit = (hit: ReturnType<typeof aMediaHit>) =>
  render(MediaHitCard, {
    providers: [provideZonelessChangeDetection()],
    inputs: { hit },
  });

describe('MediaHitCard and subjects (KBC-070)', () => {
  it('shows a track reached by its subject, with its summary and chips', async () => {
    await renderHit(
      aMediaHit({
        match: 'subject',
        text: 'Como a pergunta foi respondida.',
        highlights: [],
        subjects: [{ key: 'concept:cabala', name: 'Cabala' }],
      }),
    );
    expect(screen.getByText('Faixa · Assunto')).toBeTruthy();
    expect(screen.queryByText('Áudio · Na fala')).toBeNull();
    expect(screen.getByText('Como a pergunta foi respondida.')).toBeTruthy();
    expect(screen.getByText('Assuntos:')).toBeTruthy();
    expect(screen.getByText('Cabala')).toBeTruthy();
  });

  it('adds no empty line to a track with no summary, nor to a passage without subjects', async () => {
    await renderHit(aMediaHit());
    expect(screen.getByText('Áudio · Na fala')).toBeTruthy();
    expect(screen.queryByText('Assuntos:')).toBeNull();
  });
});
