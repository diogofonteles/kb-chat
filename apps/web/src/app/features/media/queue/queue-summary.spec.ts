import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { describe, expect, it } from 'vitest';
import { aQueueItem, MEDIA_ID } from '../../../testing/preparation-fixtures.js';
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

  it('counts one in the singular', async () => {
    await setup([item(1)], 1);
    expect(screen.getByText('1 áudio em processamento')).toBeTruthy();
  });

  it('says when only a person is awaited', async () => {
    await setup([item(1)], 0);
    expect(screen.getByText('Áudios esperando por você')).toBeTruthy();
  });
});
