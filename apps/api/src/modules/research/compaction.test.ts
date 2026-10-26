import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '../../ports/llm.js';
import {
  COMPACTED_MARK,
  compactToolResults,
  compactedText,
} from './compaction.js';
import { SourceBook } from './source-book.js';

const toolResult = (i: number): AgentMessage[] => [
  {
    role: 'assistant',
    content: `Lista parcial ${i}: [${i}]`,
    toolCalls: [{ id: `c${i}`, name: 'find_text', arguments: '{}' }],
  },
  {
    role: 'tool',
    toolCallId: `c${i}`,
    content: `Texto “livro”: 9 documento(s). Mostrando 1–2 de 9.\n[${i}] Doc ${i} · 3 ocorrência(s)\n- @12: ${'texto longo '.repeat(200)}\nPróxima página: offset=2.`,
  },
];

describe('compactToolResults (KBC-017 AC-10)', () => {
  it('keeps the last results whole and reduces the older ones to their totals and [n]', () => {
    const book = new SourceBook();
    for (let i = 1; i <= 10; i += 1)
      book.number({ id: `d${i}`, title: `Doc ${i}` });
    const messages: AgentMessage[] = [
      { role: 'system', content: 'regras' },
      { role: 'user', content: 'pergunta' },
      ...Array.from({ length: 10 }, (_, i) => toolResult(i + 1)).flat(),
    ];
    const { messages: out, compacted } = compactToolResults(messages, {
      book,
    });
    expect(compacted).toBe(4);
    const tools = out.filter((m) => m.role === 'tool');
    expect(
      tools.slice(0, 4).every((m) => m.content.startsWith(COMPACTED_MARK)),
    ).toBe(true);
    expect(
      tools.slice(4).every((m) => !m.content.startsWith(COMPACTED_MARK)),
    ).toBe(true);
    expect(tools[0]?.content).toContain('Documentos listados: [1].');
    expect(tools[0]?.content).toContain(
      'Registro: 10 documento(s) numerados até aqui ([1] a [10])',
    );
    expect(tools[1]?.content).not.toContain('Registro:');
    // The model's own notes stay as they were.
    expect(out.filter((m) => m.role === 'assistant')).toEqual(
      messages.filter((m) => m.role === 'assistant'),
    );
    expect(tools[1]?.content.length).toBeLessThan(400);
    expect(
      messages.filter((m) => m.role === 'tool')[1]?.content.length,
    ).toBeGreaterThan(2_000);
    // A second pass does not compact the same results again.
    expect(compactToolResults(out, { book }).compacted).toBe(0);
    // A later pass keeps one ledger only, on its newest compacted result.
    const later = compactToolResults(out, { book, keep: 2 }).messages.filter(
      (m) => m.role === 'tool',
    );
    expect(later.filter((m) => m.content.includes('Registro:'))).toHaveLength(
      1,
    );
    expect(later[4]?.content).toContain('Registro:');
  });

  it('keeps the first line and says how to get the text back', () => {
    const text = compactedText(
      'Busca “x” (modo all): 1–2 de 2.\n[4] A · b\n[5] C',
    );
    expect(text).toBe(
      `${COMPACTED_MARK} Busca “x” (modo all): 1–2 de 2. Documentos listados: [4] [5]. (Texto resumido para caber no contexto; chame a ferramenta de novo se precisar dele.)`,
    );
  });
});
