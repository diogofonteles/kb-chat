import { describe, expect, it } from 'vitest';
import {
  changeFieldText,
  changeValuesText,
  impactText,
  movedText,
} from './track-edit-labels.js';
import { restoreFailureText } from './track-restore-failure.js';
import { HttpErrorResponse } from '@angular/common/http';

const change = {
  id: '11111111-1111-4111-8111-111111111111',
  at: '2026-11-04T12:00:00.000Z',
  by: 'Ana',
};

describe('Track edit labels (KBC-073)', () => {
  it('FR-4: says the impact and the way back', () => {
    expect(impactText({ listeners: 3, bookmarks: 1 })).toBe(
      '3 pessoas ouviram esta faixa e 1 marcador está nela. Você pode restaurar em até 30 dias.',
    );
  });

  it('BR-4: the notice counts the bookmarks', () => {
    expect(movedText({ count: 1 })).toBe(
      '1 marcador foi movido para a gravação completa porque a faixa mudou',
    );
    expect(movedText({ count: 2 })).toContain('2 marcadores foram movidos');
  });

  it('the history reads bounds as times and a deletion as itself', () => {
    expect(
      changeValuesText({
        ...change,
        field: 'bounds',
        before: '720000-960000',
        after: '750000-930000',
      }),
    ).toBe('12:00 a 16:00 → 12:30 a 15:30');
    expect(
      changeValuesText({
        ...change,
        field: 'archived',
        before: null,
        after: null,
      }),
    ).toBe('');
    expect(changeFieldText('asker')).toBe('Quem pergunta');
  });

  it('says why a track did not come back', () => {
    const refused = new HttpErrorResponse({
      status: 409,
      error: {
        error: {
          code: 'MEDIA_CONFLICT',
          message: 'x',
          details: { reason: 'restore-expired' },
        },
      },
    });
    expect(restoreFailureText(refused)).toContain('30 dias');
  });
});
