import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
import { aQueueItem, MEDIA_ID } from '../../../testing/preparation-fixtures.js';
import { SessionStore } from '@core/auth/session-store.js';
import { ProcessingQueueStore } from './processing-queue-store.js';
import { QueueSummary } from './queue-summary.js';

const item = (n: number) =>
  aQueueItem({ mediaId: `${MEDIA_ID}${n}`, title: `Áudio ${n}` });

async function setup(items: ReturnType<typeof item>[], active: number) {
  return render(QueueSummary, {
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      {
        provide: ProcessingQueueStore,
        useValue: { items: signal(items), active: signal(active) },
      },
      { provide: SessionStore, useValue: { can: () => true } },
    ],
  });
}

describe('QueueSummary (KBC-090)', () => {
  it('shows nothing with nothing in the queue', async () => {
    const { container } = await setup([], 0);
    expect(container.querySelector('section')).toBeNull();
  });

  it('shows the first ones, how many more, and the way to the queue', async () => {
    await setup([item(1), item(2), item(3), item(4)], 2);
    expect(screen.getByText('2 áudios em processamento')).toBeTruthy();
    expect(screen.getByText('Áudio 3')).toBeTruthy();
    expect(screen.queryByText('Áudio 4')).toBeNull();
    expect(screen.getByText('e mais 1')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ver a fila' })).toBeTruthy();
  });

  it('puts what needs the person first, and leaves out what is not theirs', async () => {
    await setup(
      [
        item(1),
        item(2),
        item(3),
        { ...item(4), phase: 'attention' },
        { ...item(5), phase: 'stopped' },
      ],
      3,
    );
    expect(screen.getByText('Áudio 4')).toBeTruthy();
    expect(screen.queryByText('Áudio 5')).toBeNull();
    expect(screen.getByText('e mais 1')).toBeTruthy();
  });

  it('counts one in the singular', async () => {
    await setup([item(1)], 1);
    expect(screen.getByText('1 áudio em processamento')).toBeTruthy();
  });

  it('says when only a person is awaited', async () => {
    await setup([item(1)], 0);
    expect(screen.getByText('Precisa da sua atenção')).toBeTruthy();
  });

  it('gives each audio its state in a word and its direct action (KBC-128 FR-2)', async () => {
    await setup(
      [
        { ...item(1), phase: 'attention', state: 'failed', action: null },
        { ...item(2), waitsForTranscriber: true, action: null },
        { ...item(3), phase: 'attention', action: 'validate', step: 3 },
      ],
      1,
    );
    expect(screen.getByText('Falhou')).toBeTruthy();
    expect(screen.getByText('Aguardando')).toBeTruthy();
    expect(screen.getByText('Para validar')).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Ver detalhes: Áudio 1' }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Validar: Áudio 3' })
        .getAttribute('href'),
    ).toContain(MEDIA_ID + '3');
  });
});
