import { describe, expect, it } from 'vitest';
import { aQueueItem } from '../../../testing/preparation-fixtures.js';
import {
  queueChangeText,
  queueNextText,
  queuePositionText,
  queueProgressText,
  queueStateText,
} from './queue-labels.js';

describe('the queue in words (KBC-090)', () => {
  it('says the stage and its progress', () => {
    expect(queueStateText(aQueueItem())).toContain('Transcrição:');
    expect(queueStateText(aQueueItem())).toContain('cortes 14 de 40');
    expect(queueProgressText(aQueueItem())).toBe('Transcrição: 35 por cento');
  });

  it('says why nothing moves', () => {
    const waiting = aQueueItem({ state: 'queued', waitsForTranscriber: true });
    expect(queueStateText(waiting)).toBe(
      'Transcrição: aguardando o transcritor',
    );
  });

  it('says what failed', () => {
    const failed = aQueueItem({
      stage: 'speakers',
      state: 'failed',
      failure: null,
    });
    expect(queueStateText(failed)).toContain('Vozes: Falhou');
  });

  it('says a running or failed stage on step 3 too', () => {
    const running = aQueueItem({
      step: 3,
      stage: 'speakers',
      state: 'running',
    });
    expect(queueStateText(running)).toContain('Vozes');
    const failed = aQueueItem({ step: 3, stage: 'speakers', state: 'failed' });
    expect(queueStateText(failed)).toContain('Falhou');
  });

  it('says what is left for a person', () => {
    const rest = { stage: null, state: null, phase: 'attention' } as const;
    expect(queueStateText(aQueueItem({ ...rest, action: 'validate' }))).toBe(
      'Processamento concluído. Falta validar as faixas.',
    );
    expect(queueStateText(aQueueItem({ ...rest, action: 'conclude' }))).toBe(
      'Processamento concluído.',
    );
    expect(queueStateText(aQueueItem({ ...rest, step: 3 }))).toContain(
      'Validar faixas',
    );
  });

  it('says the place and what comes after, only when there are', () => {
    expect(queuePositionText(aQueueItem({ position: 2 }))).toBe(
      '2º na fila do transcritor',
    );
    expect(
      queuePositionText(aQueueItem({ position: 1, stage: 'convert' })),
    ).toBe('1º na conversão');
    expect(queuePositionText(aQueueItem())).toBe('');
    expect(queueNextText(aQueueItem())).toBe('Depois: Vozes');
    expect(queueNextText(aQueueItem({ nextStage: null }))).toBe('');
  });

  it('tells what started, failed or left, never the percentages', () => {
    const one = aQueueItem({ title: 'Um', state: 'queued' });
    const started = { ...one, state: 'running' as const };
    expect(queueChangeText([one], [started])).toContain('Um: Transcrição');
    expect(queueChangeText([started], [{ ...started, percent: 80 }])).toBe('');
    const failed = { ...one, state: 'failed' as const };
    expect(queueChangeText([started], [failed])).toContain('Falhou');
    expect(queueChangeText([one], [])).toBe('Um saiu da fila.');
  });

  it('counts when too much moved at once', () => {
    const items = [1, 2, 3, 4].map((n) =>
      aQueueItem({ mediaId: `${n}`, title: `Áudio ${n}` }),
    );
    expect(queueChangeText(items, [])).toBe('4 áudios mudaram na fila.');
  });
});
