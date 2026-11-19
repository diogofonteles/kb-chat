import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import type { ProcessingQueueItem } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { aQueueItem } from '../../../testing/preparation-fixtures.js';
import { QueueRow } from './queue-row.js';

async function row(item: ProcessingQueueItem) {
  const rendered = await render(QueueRow, {
    inputs: { item, topicTitle: 'Hermetismo', canEdit: true },
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: '**', children: [] }]),
    ],
  });
  await rendered.fixture.whenStable();
  return rendered;
}

/** Every stage done, waiting for this person (the queue's "Precisa de você"). */
const waitingForYou = (action: ProcessingQueueItem['action']) =>
  aQueueItem({
    phase: 'attention',
    stage: null,
    state: null,
    percent: null,
    cuts: null,
    nextStage: null,
    action,
    step: 3,
  });

function pill(host: HTMLElement): string {
  return host.querySelector('ui-pill')?.textContent?.trim() ?? '';
}

describe('QueueRow (v2 · Fila, KBC-129 FR-4)', () => {
  it('says "Precisa de você" in warning, never "Concluído", when the tracks wait to be validated', async () => {
    const { fixture } = await row(waitingForYou('validate'));
    const host = fixture.nativeElement as HTMLElement;
    expect(pill(host)).toBe('Precisa de você');
    expect(host.dataset['tone']).toBe('warn');
    expect(screen.getByRole('button', { name: 'Validar faixas' })).toBeTruthy();
  });

  it('says "Precisa de você" in warning when the plan waits to be concluded', async () => {
    const { fixture } = await row(waitingForYou('conclude'));
    const host = fixture.nativeElement as HTMLElement;
    expect(pill(host)).toBe('Precisa de você');
    expect(host.dataset['tone']).toBe('warn');
  });

  it('says "Precisa de você" in warning when the plan waits to be continued', async () => {
    const { fixture } = await row(
      aQueueItem({ phase: 'attention', state: 'done', action: 'continue' }),
    );
    expect(pill(fixture.nativeElement as HTMLElement)).toBe('Precisa de você');
  });

  it('marks the last step current, not done, while the person still has to act', async () => {
    await row(waitingForYou('validate'));
    const steps = screen.getAllByRole('listitem');
    expect(steps.at(-1)?.getAttribute('aria-current')).toBe('step');
  });

  it('says "Falhou" in red when the action is to try again', async () => {
    const { fixture } = await row(
      aQueueItem({
        phase: 'attention',
        stage: 'tracks',
        state: 'done',
        action: 'retry',
        retryStage: 'tracks',
      }),
    );
    const host = fixture.nativeElement as HTMLElement;
    expect(pill(host)).toBe('Falhou');
    expect(host.dataset['tone']).toBe('err');
  });

  it('says "Concluído" only when every stage is done and nothing is asked', async () => {
    const { fixture } = await row(
      aQueueItem({ phase: 'stopped', stage: null, state: null, action: null }),
    );
    expect(pill(fixture.nativeElement as HTMLElement)).toBe('Concluído');
  });

  it('keeps "Processando" for a stage at work', async () => {
    const { fixture } = await row(aQueueItem());
    expect(pill(fixture.nativeElement as HTMLElement)).toBe('Processando');
  });
});
