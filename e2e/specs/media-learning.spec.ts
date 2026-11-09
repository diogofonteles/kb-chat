import AxeBuilder from '@axe-core/playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { APIRequestContext, Locator, Page } from '@playwright/test';
import { CSRF, expect, ownerApi, test } from './fixtures.js';
import { uniqueTag, uploadReady } from './media-helpers.js';
import { seedDraft, trackRow } from './tracks-helpers.js';
import {
  rawOf,
  seedTranscript,
  type SpokenLine,
} from './transcript-helpers.js';

// KBC-113: what a correction teaches. A recording's "a <word>" corrected to "Atlântida"
// becomes a rule with its context; the next recording seeded with the rules gets it
// replaced, marked and undoable on step 3; masters switch the rule in Termos da transcrição.

/** Letters only: the word is part of the rule's text, unique per test (TE-18). */
const uniqueWord = () =>
  `Manta${(uniqueTag() + Math.random().toString(36))
    .replace(/[^a-z]/g, '')
    .slice(-8)}`;

const desktop = (page: Page) => (page.viewportSize()?.width ?? 0) >= 1024;

interface WordRow {
  readonly position: number;
  readonly text: string;
}

async function recording(
  owner: APIRequestContext,
  speech: readonly SpokenLine[],
  learn = false,
): Promise<string> {
  const { id } = await uploadReady(owner, {
    title: `Aprendizado ${uniqueTag()}`,
    seconds: 40,
    bitrate: '32k',
  });
  await seedTranscript(owner, { id, raw: rawOf(speech), learn });
  return id;
}

/** "a <word>" corrected to "Atlântida", as "Incluir a próxima" sends it. */
async function teach(owner: APIRequestContext, word: string): Promise<void> {
  const id = await recording(owner, [
    { at: 2, text: `disse com a ${word} foi assim` },
  ]);
  const read = await owner.get(
    `/api/v1/media/${id}/transcript/words?from=0&count=10`,
  );
  const { words } = (await read.json()) as { words: WordRow[] };
  const first = words.find((one) => one.text === 'a');
  const saved = await owner.post(`/api/v1/media/${id}/transcript/corrections`, {
    data: {
      version: 1,
      position: first?.position,
      count: 2,
      expected: ['a', word],
      text: 'Atlântida',
    },
    headers: CSRF,
  });
  expect(saved.status(), await saved.text()).toBe(201);
}

/** The words painted as learned (FR-6). */
const learnedPainted = (page: Page) =>
  page.evaluate(() => {
    interface Registry {
      get(name: string): Iterable<Range> | undefined;
    }
    const registry = (CSS as unknown as { highlights: Registry }).highlights;
    return Array.from(registry.get('learned-word') ?? []).map((range) =>
      range.toString(),
    );
  });

/** Clicks a word of the text where the browser draws it. */
async function clickWord(region: Locator, word: string) {
  const box = await region.evaluate((element, word) => {
    for (const line of Array.from(element.querySelectorAll('.line'))) {
      const node = line.firstChild;
      const at = node?.textContent?.indexOf(word) ?? -1;
      if (!node || at < 0) continue;
      line.scrollIntoView({ block: 'center' });
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + word.length);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    }
    return null;
  }, word);
  if (!box) throw new Error(`no "${word}" in the text`);
  await region.page().mouse.click(box.x, box.y);
}

async function evidence(page: Page, name: string): Promise<void> {
  const dir = process.env['KBC_EVIDENCE_DIR'];
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const width = page.viewportSize()?.width ?? 0;
  await page.screenshot({ path: join(dir, `${name}-${width}.png`) });
}

const seriousViolations = async (page: Page, scope: string) =>
  (await new AxeBuilder({ page }).include(scope).analyze()).violations.filter(
    (violation) => ['serious', 'critical'].includes(violation.impact ?? ''),
  );

test('AC-2, AC-8, AC-17: a learned word is marked on step 3, says what it was, and Desfazer brings it back', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const word = uniqueWord();
  const owner = await ownerApi();
  await teach(owner, word);
  const id = await recording(
    owner,
    [
      { at: 5, text: `e com a ${word} veio` },
      { at: 12, text: `na a ${word} disse` },
    ],
    true,
  );
  await seedDraft(owner, id, [
    { startMs: 0, endMs: 30_000, title: 'Primeira pergunta' },
  ]);
  await owner.dispose();

  await page.goto(`/midia/${id}/faixas`);
  await trackRow(page, 1).getByRole('button').first().click();
  const region = page.getByRole('region', { name: 'Texto da faixa 1' });
  await expect(region).toContainText('e com Atlântida veio');
  await expect(region).toContainText(`na a ${word} disse`);
  await expect.poll(() => learnedPainted(page)).toEqual(['Atlântida']);
  await expect(
    region
      .page()
      .getByText(
        '1 palavra corrigida pelo aprendizado (sublinhado pontilhado)',
      ),
  ).toBeVisible();

  await clickWord(region, 'Atlântida');
  const panel = page.getByRole('dialog', { name: /^Corrigir palavra/ });
  await expect(
    panel.getByText(`Corrigida pelo aprendizado · era «a ${word}»`),
  ).toBeVisible();
  await evidence(page, 'kbc-113-learned-word');
  expect(await seriousViolations(page, 'app-track-text')).toEqual([]);

  await panel.getByRole('button', { name: 'Desfazer' }).click();

  await expect(region).toContainText(`e com a ${word} veio`);
  await expect(panel).toBeHidden();
  await expect.poll(() => learnedPainted(page)).toEqual([]);
});

test('AC-1, AC-15, AC-19: a master sees the rule with its context and turns it off at once', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const word = uniqueWord();
  const owner = await ownerApi();
  await teach(owner, word);
  await owner.dispose();

  await page.goto('/biblioteca');
  if (!desktop(page))
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = page.getByRole('dialog', { name: 'Configurações' });
  await dialog.getByRole('button', { name: 'Termos da transcrição' }).click();
  // The name holds what the switch shows, "Ligada"/"Desligada" (WCAG 2.5.3).
  const name = new RegExp(`^Regra a ${word} → Atlântida: `);
  const rule = dialog.getByRole('switch', { name });
  // The list shows 20 rules at a time; other runs may have taught more.
  const more = dialog.getByRole('button', { name: /^Mostrar mais/ });
  while (!(await rule.isVisible()) && (await more.isVisible()))
    await more.click();
  await expect(rule).toHaveAttribute('aria-checked', 'true');
  await expect(rule).toHaveAccessibleName(
    `Regra a ${word} → Atlântida: Ligada`,
  );
  // `has` is matched inside each item: rooted at the page, not the dialog.
  const item = dialog
    .getByRole('listitem')
    .filter({ has: page.getByRole('switch', { name }) });
  await expect(item).toContainText('depois de «com» · antes de «foi»');
  await expect(item).toContainText('1 correção em 1 gravação');
  await rule.scrollIntoViewIfNeeded();
  await evidence(page, 'kbc-113-learning-panel');
  expect(await seriousViolations(page, 'app-learning-panel')).toEqual([]);

  await rule.focus();
  await page.keyboard.press('Enter');

  await expect(rule).toHaveAttribute('aria-checked', 'false');
  await expect(item).toContainText('Desligada por');
  await expect(
    dialog.getByText('Regra desligada. Vale para as próximas transcrições.'),
  ).toBeVisible();
  await evidence(page, 'kbc-113-learning-panel-off');
  // The master's choice can be dropped: undos and the rules decide again (BR-11).
  await item.getByRole('button', { name: /^Voltar ao automático/ }).click();
  await expect(rule).toHaveAttribute('aria-checked', 'true');
  await expect(
    item.getByRole('button', { name: /^Voltar ao automático/ }),
  ).toHaveCount(0);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > window.innerWidth,
  );
  expect(overflow).toBe(false);
});
