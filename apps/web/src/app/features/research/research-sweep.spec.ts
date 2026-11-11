import type { SweepCoverage } from '@kb-chat/contracts';
import { coverageText } from './research-sweep.js';

const WHOLE: SweepCoverage = {
  target: {},
  phrases: [],
  documents: 2700,
  scanned: 2700,
  withHits: null,
  read: 412,
  needed: 2700,
  missing: 2288,
  batches: 40,
};

describe('coverageText, tracks counted apart (KBC-101 BR-2)', () => {
  it('says how many of the set and of those read are tracks', () => {
    expect(
      coverageText({ ...WHOLE, tracks: { documents: 145, read: 30 } }),
    ).toBe(
      'Cobertura (medida pelo aplicativo): 2.700 documentos no conjunto (145 faixas de áudio) · 412 lidos por inteiro pela IA (30 faixas).',
    );
  });

  it('with phrases, the tracks go with the set and with what the AI analyzed', () => {
    expect(
      coverageText({
        ...WHOLE,
        phrases: ['pêndulo'],
        withHits: 1,
        read: 1,
        needed: 1,
        missing: 0,
        tracks: { documents: 1, read: 1 },
      }),
    ).toBe(
      'Cobertura (medida pelo aplicativo): 2.700 documentos no conjunto (1 faixa de áudio) · 2.700 conferidos pelas expressões · 1 com ocorrências · 1 analisados pela IA (1 faixa).',
    );
  });

  it('AC-5: without tracks in the set, nothing says "faixa"', () => {
    expect(coverageText(WHOLE)).not.toMatch(/faixa/);
  });
});
