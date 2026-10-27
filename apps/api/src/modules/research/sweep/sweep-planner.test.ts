import { sweepPlanSchema, type SweepPlan } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  MemoryVault,
  memoryDoc,
  memoryTools,
} from '../../../../test/memory-research.js';

const MESTRE = 'José Laércio do Egito';

/** Four lectures of the Mestre (one big), one book by another author. */
function corpus(): Record<string, string> {
  const lecture = (i: number, body: string) =>
    memoryDoc({
      title: `Tema ${i}`,
      body,
      entities: [MESTRE],
      sourcePath: `_convert/Temas-docs/TEMA ${i}.txt`,
      authorGroup: 'mestre-laercio',
    });
  const filler = 'texto sem nada de especial. '.repeat(400);
  return {
    'raw/t1.md': lecture(1, `Leiam o livro O Caibalion. ${filler}`),
    'raw/t2.md': lecture(2, 'Nada aqui sobre leituras.'),
    'raw/t3.md': lecture(
      3,
      `${filler}Recomendo a obra Ísis sem Véu. ${filler}Outro livro: A Doutrina Secreta.`,
    ),
    'raw/t4.md': lecture(4, 'Curto.'),
    'raw/caibalion.md': memoryDoc({
      title: 'O Caibalion',
      body: 'Um livro de outro autor.',
      authorGroup: 'outros-autores',
    }),
  };
}

const plan = (fields: Partial<SweepPlan> = {}): SweepPlan =>
  sweepPlanSchema.parse({
    target: { authorship: 'mestre-laercio' },
    extract: 'livros citados',
    ...fields,
  });

async function planner() {
  const tools = await memoryTools(new MemoryVault(corpus()));
  return tools.sweeps;
}

describe('SweepPlanner (KBC-030)', () => {
  it('resolves the whole target set in id order and reads every body without phrases', async () => {
    const layout = await (
      await planner()
    ).layout('hermetismo', { plan: plan(), batchChars: 30_000 });
    expect(layout?.docs.map((d) => d.entry.id)).toEqual([
      'raw/t1.md',
      'raw/t2.md',
      'raw/t3.md',
      'raw/t4.md',
    ]);
    expect(layout?.withHits).toBeNull();
    const units = layout?.batches.flatMap((b) => b.units) ?? [];
    expect(new Set(units.map((u) => u.entry.id)).size).toBe(4);
    for (const doc of layout?.docs ?? [])
      expect(doc.units.at(-1)?.end).toBe(doc.length);
  });

  it('splits a document longer than a batch into windows and packs batches up to the size', async () => {
    const layout = await (
      await planner()
    ).layout('hermetismo', { plan: plan(), batchChars: 4_000 });
    const t3 = layout?.docs.find((d) => d.entry.id === 'raw/t3.md');
    expect(t3?.units.length).toBeGreaterThan(5);
    for (const batch of layout?.batches ?? [])
      expect(batch.chars).toBeLessThanOrEqual(4_000);
  });

  it('with phrases, scans every document and batches only the windows around occurrences', async () => {
    const layout = await (
      await planner()
    ).layout('hermetismo', {
      plan: plan({ phrases: ['livro', 'obra'] }),
      batchChars: 30_000,
    });
    expect(layout?.scanned).toBe(4);
    expect(layout?.withHits).toBe(2);
    const ids = new Set(
      layout?.batches.flatMap((b) => b.units.map((u) => u.entry.id)),
    );
    expect([...ids].sort()).toEqual(['raw/t1.md', 'raw/t3.md']);
    const t3 = layout?.docs.find((d) => d.entry.id === 'raw/t3.md');
    const read = t3?.units.reduce((sum, u) => sum + u.end - u.start, 0) ?? 0;
    expect(read).toBeLessThan((t3?.length ?? 0) / 2);
  });

  it('skips the documents a cursor already covered', async () => {
    const layout = await (
      await planner()
    ).layout('hermetismo', {
      plan: plan(),
      batchChars: 30_000,
      after: 'raw/t2.md',
    });
    expect(layout?.skipped).toBe(2);
    expect(
      layout?.batches.flatMap((b) => b.units.map((u) => u.entry.id)),
    ).not.toContain('raw/t1.md');
  });

  it('reads a batch as labelled, fenced document text', async () => {
    const sweeps = await planner();
    const layout = await sweeps.layout('hermetismo', {
      plan: plan({ phrases: ['livro'] }),
      batchChars: 30_000,
    });
    const batch = layout?.batches[0];
    if (!batch) throw new Error('no batch');
    const text = await sweeps.batchText('hermetismo', batch);
    expect(text.labels.size).toBeGreaterThan(0);
    expect(text.text).toContain('[D1] Tema 1');
    expect(text.text).toContain('autoria: Mestre Laércio');
    expect(text.text).toContain('<<<DOCUMENTO');
    expect(text.text).toContain('Leiam o livro O Caibalion');
  });

  it('answers null for an unknown topic', async () => {
    expect(
      await (await planner()).layout('nope', { plan: plan(), batchChars: 1 }),
    ).toBeNull();
  });
});
