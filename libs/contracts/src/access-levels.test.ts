import { describe, expect, it } from 'vitest';
import {
  foldLevelCode,
  levelCreateSchema,
  levelIdOf,
  levelIdSchema,
  levelRenameSchema,
} from './access-levels.js';

describe('access levels contracts (KBC-103, ADR 0036 §1)', () => {
  it('derives a fixed id from the first code', () => {
    expect(levelIdOf('QS')).toBe('qs');
    expect(levelIdOf('QM+')).toBe('qm-plus');
    expect(levelIdOf('C.I.')).toBe('c-i');
    expect(levelIdOf('Côr Ânima')).toBe('cor-anima');
    expect(levelIdOf('...')).toBe('');
  });

  it('QA-3: keeps every id within the id schema, whatever the 12 characters are', () => {
    for (const code of ['++++++++++++', 'A+B+C+D+E+F+', '+a+b+c+d+e+f']) {
      const id = levelIdOf(code);
      expect(levelIdSchema.safeParse(id).success, `${code} → ${id}`).toBe(true);
      expect(id.length).toBeLessThanOrEqual(32);
    }
  });

  it('BR-2: folds case and accents to compare codes', () => {
    expect(foldLevelCode(' Qś ')).toBe(foldLevelCode('QS'));
  });

  it('BR-2: a code has up to 12 characters; a rename changes something', () => {
    expect(levelCreateSchema.safeParse({ code: 'A'.repeat(12) }).success).toBe(
      true,
    );
    expect(levelCreateSchema.safeParse({ code: 'A'.repeat(13) }).success).toBe(
      false,
    );
    expect(levelCreateSchema.parse({ code: 'QS' }).description).toBe('');
    expect(levelRenameSchema.safeParse({}).success).toBe(false);
  });
});
