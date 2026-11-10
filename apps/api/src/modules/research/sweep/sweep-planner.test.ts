import { sweepPlanSchema, type SweepPlan } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import {
  MemoryVault,
  memoryDoc,
  memoryTools,
} from '../../../../test/memory-research.js';
import { coveredMark } from './sweep-cursor.js';
import { OPEN_VIEW } from '../../access-levels/index.js';

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
    ).layout('hermetismo', {
      plan: plan(),
      batchChars: 30_000,
      view: OPEN_VIEW,
    });
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
    ).layout('hermetismo', {
      plan: plan(),
      batchChars: 4_000,
      view: OPEN_VIEW,
    });
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
      view: OPEN_VIEW,
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
      view: OPEN_VIEW,
      after: 'raw/t2.md',
    });
    expect(layout?.skipped).toBe(2);
    expect(
      layout?.batches.flatMap((b) => b.units.map((u) => u.entry.id)),
    ).not.toContain('raw/t1.md');
  });

  it('resumes a cursor over a set that changed since: only documents it never covered are read (code review 2 of KBC-101)', async () => {
    // t1 and t2 swept; since then t4 left and t15 joined (its id sorts before the cursor's).
    const docs = Object.fromEntries(
      Object.entries(corpus()).filter(([id]) => id !== 'raw/t4.md'),
    );
    docs['raw/t15.md'] = docs['raw/t2.md'] ?? '';
    const sweeps = (await memoryTools(new MemoryVault(docs))).sweeps;
    const layout = await sweeps.layout('hermetismo', {
      plan: plan(),
      batchChars: 30_000,
      view: OPEN_VIEW,
      after: 'raw/t2.md',
      covered: coveredMark(['raw/t1.md', 'raw/t2.md']),
    });
    expect(layout?.skipped).toBe(2);
    expect(layout?.docs.slice(0, 2).map((d) => d.entry.id)).toEqual([
      'raw/t1.md',
      'raw/t2.md',
    ]);
    expect([
      ...new Set(
        layout?.batches.flatMap((b) => b.units.map((u) => u.entry.id)),
      ),
    ]).toEqual(['raw/t15.md', 'raw/t3.md']);
  });

  it('resumes a cursor from before the covered mark after its id, over the same set', async () => {
    const layout = await (
      await planner()
    ).layout('hermetismo', {
      plan: plan(),
      batchChars: 30_000,
      view: OPEN_VIEW,
      after: 'raw/t2.md',
    });
    expect(layout?.skipped).toBe(2);
    expect(layout?.batches.length).toBeGreaterThan(0);
  });

  it('reads a batch as labelled, fenced document text', async () => {
    const sweeps = await planner();
    const layout = await sweeps.layout('hermetismo', {
      plan: plan({ phrases: ['livro'] }),
      batchChars: 30_000,
      view: OPEN_VIEW,
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
      await (
        await planner()
      ).layout('nope', { plan: plan(), batchChars: 1, view: OPEN_VIEW }),
    ).toBeNull();
  });

  it('plans the Mestre’s documents by default when the question names him and the topic has them', async () => {
    const plan = (await planner()).defaultPlan(
      'hermetismo',
      'O que o Mestre Laércio diz?',
      OPEN_VIEW,
    );
    expect(plan.target).toEqual({ authorship: 'mestre-laercio' });
    expect(plan.extract).toBe('O que o Mestre Laércio diz?');
  });

  it('falls back to the whole topic when it has no document of the Mestre (architecture review)', async () => {
    const tools = await memoryTools(
      new MemoryVault({ 'raw/x.md': memoryDoc({ title: 'X', body: 'texto' }) }),
    );
    expect(
      tools.sweeps.defaultPlan('hermetismo', 'o que o Mestre diz?', OPEN_VIEW)
        .target,
    ).toEqual({});
  });
});
