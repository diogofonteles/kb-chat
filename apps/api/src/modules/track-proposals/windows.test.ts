import { describe, expect, it } from 'vitest';
import { windowPrompt } from './prompt.js';
import { buildPlan, callCeiling } from './proposal-plan.js';
import {
  clock,
  cutCandidates,
  segmentLine,
  splitWindows,
  toPromptSegments,
  voiceOfLabel,
  voiceStats,
  type PromptSegment,
} from './windows.js';

const derived = (startMs: number, endMs: number, text: string) => ({
  startMs,
  endMs,
  text,
  avgLogprob: null,
  compressionRatio: null,
  noSpeechProb: null,
});

const segment = (
  id: number,
  startMs: number,
  extra: Partial<PromptSegment> = {},
): PromptSegment => ({
  id,
  startMs,
  endMs: startMs + 1_000,
  text: `fala ${id}`,
  voice: null,
  ...extra,
});

describe('the transcript as the AI reads it (KBC-067 FR-2)', () => {
  it('numbers segments from 1 with their voices, or none without a separation', () => {
    const segments = [derived(0, 900, ' Olá '), derived(1_000, 2_000, 'Tudo?')];
    expect(toPromptSegments(segments, [2, null])).toEqual([
      { id: 1, startMs: 0, endMs: 900, text: 'Olá', voice: 2 },
      { id: 2, startMs: 1_000, endMs: 2_000, text: 'Tudo?', voice: null },
    ]);
    expect(toPromptSegments(segments, null)[0]?.voice).toBeNull();
  });

  it('splits by start time and skips empty windows', () => {
    const windows = splitWindows(
      [segment(1, 0), segment(2, 59_000), segment(3, 190_000)],
      60_000,
    );
    expect(windows.map((one) => one.map((s) => s.id))).toEqual([[1, 2], [3]]);
  });

  it('finds cut candidates: a voice change, a question just asked, a silence', () => {
    const window = [
      segment(2, 1_000, { voice: 1 }),
      segment(3, 2_000, { voice: 2, text: 'pode falar?' }),
      segment(4, 3_000, { voice: 2 }),
      segment(5, 5_500, { voice: 2 }),
      segment(6, 6_500, { voice: null }),
    ];
    expect(cutCandidates(window, segment(1, 0, { voice: 1 }))).toEqual([
      3, 4, 5,
    ]);
    expect(cutCandidates(window, null)).toEqual([3, 4, 5]);
  });

  it('measures each voice and reads voice labels back', () => {
    expect(
      voiceStats([
        segment(1, 0, { voice: 2 }),
        segment(2, 1_000, { voice: 1 }),
        segment(3, 2_000, { voice: 1 }),
        segment(4, 3_000),
      ]),
    ).toEqual([
      { voice: 1, speakingMs: 2_000, segments: 2 },
      { voice: 2, speakingMs: 1_000, segments: 1 },
    ]);
    expect(voiceOfLabel(' voz 3 ')).toBe(3);
    expect(voiceOfLabel('Voz 11')).toBeNull();
    expect(voiceOfLabel('Mestre')).toBeNull();
    expect(voiceOfLabel(null)).toBeNull();
  });

  it('writes lines as `[id] mm:ss Voz N: texto`, minutes past the hour too', () => {
    expect(clock(3_725_000)).toBe('62:05');
    expect(segmentLine(segment(7, 61_000, { voice: 3 }))).toBe(
      '[7] 01:01 Voz 3: fala 7',
    );
    expect(segmentLine(segment(8, 0))).toBe('[8] 00:00 fala 8');
  });
});

describe('the prompt and the estimate (KBC-067 BR-3)', () => {
  const context = {
    collection: 'Hermetismo',
    title: 'Palestra',
    author: null,
    knownNames: [],
    terms: ['UDV'],
  };

  it('says when voices were not separated and nobody is known', () => {
    const prompt = windowPrompt({
      context: { ...context, voices: [] },
      window: [segment(1, 0)],
      before: null,
      position: { index: 0, total: 1 },
      previous: [],
    });
    expect(prompt).toContain('Vozes: não separadas nesta gravação.');
    expect(prompt).toContain('Autor do áudio: não informado.');
    expect(prompt).toContain('conhecidos do acervo: nenhum cadastrado.');
    expect(prompt).toContain('Candidatos de corte: nenhum.');
  });

  it('prices every window once with its whole output budget', () => {
    const price = { input: 1e-7, output: 1e-6 };
    const plan = buildPlan({
      mediaId: 'm',
      transcriptId: 't',
      segments: [segment(1, 0), segment(2, 700_000)],
      context: { ...context, author: 'Mestre Gabriel' },
      model: { id: 'stub', price },
    });
    expect(plan.windows).toHaveLength(2);
    expect(plan.evidence.knownNames).toEqual(['Mestre Gabriel']);
    const oneCall = callCeiling([{ role: 'user', content: 'x' }], price);
    expect(plan.estimateUsd).toBeGreaterThan(2 * oneCall);
    expect(plan.estimateUsd).toBeLessThan(0.01);
  });
});
