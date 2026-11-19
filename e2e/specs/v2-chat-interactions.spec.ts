import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures.js';
import {
  expectSummary,
  modeRadio,
  startInSearchView,
  viewRadio,
} from './search-view.js';
import { desktop, startNewCollection } from './shell-helpers.js';

/**
 * v2 · Conversa as it is used (KBC-126/KBC-127, the fidelity pass): every control of the
 * home, the results, the document page and the AI research does what it says, at 1440 and
 * 390, in Chromium and WebKit (the chat-webkit projects). The scroll of each text is
 * content-scroll.spec's.
 */

/** Wholly inside the window: a menu or a sheet is never clipped (owner rule 1). */
async function expectOnScreen(page: Page, region: Locator): Promise<void> {
  await expect(region).toBeVisible();
  const box = await region.boundingBox();
  const viewport = page.viewportSize();
  expect(box && viewport).toBeTruthy();
  if (!box || !viewport) return;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
}

async function searchByMeaning(page: Page, question: string): Promise<void> {
  await page.goto('/');
  await (await modeRadio(page, 'Por significado')).check();
  await page.getByLabel('Sua pergunta').fill(question);
  await page
    .locator('app-composer')
    .getByRole('button', { name: 'Buscar', exact: true })
    .click();
  await expect(page.locator('app-result-card').first()).toBeVisible();
}

test.describe('the home', () => {
  test.beforeEach(startInSearchView);

  test('the scope chips choose where to search, by click and by arrows', async ({
    page,
  }) => {
    await page.goto('/');
    const scope = page.getByRole('radiogroup', { name: 'Onde buscar' });
    await expect(viewRadio(page, 'search')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await scope.getByRole('radio', { name: 'Documentos' }).click();
    await expect(
      scope.getByRole('radio', { name: 'Documentos' }),
    ).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('ArrowLeft');
    await expect(viewRadio(page, 'search')).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await viewRadio(page, 'research').click();
    await expect(
      page.getByText('O que você quer pesquisar no acervo?'),
    ).toBeVisible();
    const question = page.getByLabel('Sua pergunta');
    await question.fill('o que é o ritmo?');
    await expect(question).toHaveValue('o que é o ritmo?');
  });

  test('"Em:" opens the collections whole on screen and Escape closes it (desktop)', async ({
    page,
  }) => {
    test.skip(!desktop(page), 'A phone chooses the collection in Acervos.');
    await page.goto('/');
    const trigger = page.locator('app-scope-bar .collection-chip');
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Trocar de acervo' });
    await expectOnScreen(page, menu);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });
});

test.describe('the results', () => {
  test.beforeEach(startInSearchView);

  test('the mode pill searches again in the mode chosen (desktop)', async ({
    page,
  }) => {
    test.skip(!desktop(page), 'A phone chooses the mode in the question box.');
    await searchByMeaning(page, 'natureza');
    await expectSummary(page, /documentos?$/, 'Por significado');
    const message = page.locator('app-result-message').last();
    await message
      .getByRole('button', { name: 'Modo da busca: Por significado' })
      .click();
    const modes = page.getByRole('menu', { name: 'Como buscar' });
    await expectOnScreen(page, modes);
    await modes.getByRole('menuitemradio', { name: 'Palavras exatas' }).click();
    await expect(modes).toBeHidden();
    await expectSummary(page, /documentos?$/, 'Palavras exatas');
  });

  test("a row's ⋯ opens its document, and the page's ✕ returns to the results", async ({
    page,
  }) => {
    await searchByMeaning(page, 'natureza');
    const row = page
      .locator('app-result-card')
      .filter({ hasText: 'A Árvore da Vida' })
      .first();
    const more = row.getByRole('button', { name: 'Mais opções' });
    await more.click();
    const menu = page.getByRole('menu', { name: /Mais opções para/ });
    await expectOnScreen(page, menu);
    await menu.getByRole('menuitem', { name: 'Abrir documento' }).click();
    const doc = page.locator('app-document-panel');
    await expect(doc.getByRole('heading', { level: 2 })).toHaveText(
      /A Árvore da Vida/i,
    );
    await doc.getByRole('button', { name: 'Fechar' }).first().click();
    await expect(doc).toBeHidden();
    await expect(page.locator('app-result-card').first()).toBeVisible();
  });

  test('a subject chip filters: a popover on desktop, its own sheet on a phone', async ({
    page,
  }) => {
    await searchByMeaning(page, 'natureza');
    const chip = page.getByRole('button', { name: /^Assuntos/ });
    await chip.click();
    const place = desktop(page)
      ? page.getByRole('group', { name: 'Assuntos' })
      : page.getByRole('dialog', { name: 'Assuntos' });
    await expectOnScreen(page, place);
    await place.getByRole('checkbox', { name: /Cabala/ }).check();
    await place.getByRole('button', { name: 'Aplicar' }).click();
    await expect(place).toBeHidden();
    await expect(chip).toBeFocused();
    await expect(chip).toContainText('(1)');
  });

  test('a popover keeps its ticks until Aplicar; Escape after a tick leaves the filters (desktop)', async ({
    page,
  }) => {
    test.skip(!desktop(page), 'Phones filter in sheets.');
    await searchByMeaning(page, 'natureza');
    const before = await page.locator('app-result-card').count();
    const chip = page.getByRole('button', { name: /^Assuntos/ });
    await chip.click();
    const popover = page.getByRole('group', { name: 'Assuntos' });
    // A click (Safari keeps the focus on the page), then Escape: closed, nothing applied.
    await popover.locator('label', { hasText: /Cabala/ }).click();
    await expect(
      popover.getByRole('checkbox', { name: /Cabala/ }),
    ).toBeChecked();
    await expect(page.locator('app-result-card')).toHaveCount(before);
    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(chip).not.toContainText('(1)');
    await expect(page.locator('app-result-card')).toHaveCount(before);
  });

  test('the Filtros sheet folds its facets, clears and is dismissed (phone)', async ({
    page,
  }) => {
    test.skip(desktop(page), 'Desktop filters in popovers.');
    await searchByMeaning(page, 'natureza');
    const before = await page.locator('app-result-card').count();
    await page.getByRole('button', { name: 'Filtros', exact: true }).click();
    const sheet = page.getByRole('dialog', { name: 'Filtros' });
    await expectOnScreen(page, sheet);
    const genres = sheet.locator('details', {
      has: page.locator('[data-sheet-facet="genres"]'),
    });
    await expect(genres).not.toHaveAttribute('open', '');
    await genres.locator('summary').click();
    await expect(genres).toHaveAttribute('open', '');
    const first = genres.getByRole('checkbox').first();
    await first.check();
    // A narrower choice is counted on the results already there (filterSections).
    await expect(
      sheet.getByRole('button', { name: /^Ver \d+ resultados?$/ }),
    ).toBeVisible();
    await sheet.getByRole('button', { name: 'Limpar' }).click();
    await expect(first).not.toBeChecked();
    // filterSections: "Autoria" radios and the first facet open, no Cancelar (Escape).
    await expect(sheet.getByRole('group', { name: 'Autoria' })).toBeVisible();
    await expect(sheet.getByRole('radio', { name: /^Todos/ })).toBeChecked();
    await expect(sheet.getByRole('button', { name: 'Cancelar' })).toHaveCount(
      0,
    );
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    await expect(page.locator('app-result-card')).toHaveCount(before);
  });
});

test.describe('the document page', () => {
  test.beforeEach(startInSearchView);
  test.beforeEach(async ({ page }) => {
    // The share sheet of the system is stubbed: the page hands it the title and summary.
    await page.addInitScript(() => {
      const shared: unknown[] = [];
      Object.defineProperty(window, '__shared', { value: shared });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: (data: unknown) => {
          shared.push(data);
          return Promise.resolve();
        },
      });
    });
  });

  test('its tools: the occurrences step, Compartilhar shares, a subject opens', async ({
    page,
  }) => {
    // Two words apart in the text: two occurrences ("NATUREZA SÉTUPLA" side by side is one).
    await searchByMeaning(page, 'setupla setuplicidade');
    await page
      .locator('app-result-card')
      .filter({ hasText: /A Natureza Sétupla/i })
      .first()
      .locator('button.card')
      .click();
    const doc = page.locator('app-document-panel');
    const tools = doc.getByRole('toolbar', {
      name: 'Ferramentas do documento',
    });
    // "1 de 2 ⌃ ⌄": among the tools on desktop, at the hero's top right on a phone (cmDoc).
    const occurrences = doc.locator('.occurrences');
    await expect(occurrences).toHaveCount(1);
    await expect(occurrences).toHaveClass(
      desktop(page) ? /in-tools/ : /in-hero/,
    );
    await expect(occurrences.getByText(/^1 de 2/)).toBeVisible();
    await occurrences
      .getByRole('button', { name: /Próxima ocorrência|ocorrência/ })
      .last()
      .click();
    await expect(occurrences.getByText(/^2 de 2/)).toBeVisible();
    await occurrences
      .getByRole('button', { name: 'Ocorrência anterior' })
      .click();
    await expect(occurrences.getByText(/^1 de 2/)).toBeVisible();

    await tools.getByRole('button', { name: 'Compartilhar' }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { __shared: { title: string }[] }).__shared[0]
              ?.title,
        ),
      )
      .toMatch(/NATUREZA/i);

    // "Veja também" beside the text (desktop) or under it (phone): Cabala opens its page.
    await doc
      .getByRole('button', { name: /^Cabala/ })
      .first()
      .click();
    await expect(doc.getByText('Assunto · Síntese do acervo')).toBeVisible();
    await expect(doc.getByRole('heading', { level: 2 })).toHaveText('Cabala');
    await doc.getByRole('button', { name: 'Voltar' }).click();
    await expect(doc.getByRole('heading', { level: 2 })).toHaveText(
      /NATUREZA/i,
    );
  });
});

test.describe('the document page menu', () => {
  test.beforeEach(startInSearchView);

  test('Escape with its ⋯ open closes the menu only, then a second one the page', async ({
    page,
  }) => {
    await searchByMeaning(page, 'natureza setupla');
    await page
      .locator('app-result-card')
      .filter({ hasText: /A Natureza Sétupla/i })
      .first()
      .locator('button.card')
      .click();
    const doc = page.locator('app-document-panel');
    await expect(doc.getByRole('heading', { level: 2 })).toBeVisible();
    await doc.getByRole('button', { name: 'Mais opções' }).first().click();
    const menu = page.getByRole('menu', { name: 'Mais opções do documento' });
    await expectOnScreen(page, menu);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(doc.getByRole('heading', { level: 2 })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(doc).toBeHidden();
  });
});

test.describe('the phone tabs', () => {
  test.beforeEach(startInSearchView);

  test('Conversas lists the conversations, a row reopens one, Buscar keeps its tab on', async ({
    page,
  }) => {
    test.skip(desktop(page), 'The tabs are the phone navigation.');
    // Reopening from the list throws nothing (it once called .set on a computed signal).
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await searchByMeaning(page, 'lei do ritmo');
    await page.goto('/');
    const nav = page.locator('app-bottom-nav');
    await nav.getByRole('link', { name: 'Conversas' }).click();
    const list = page.getByRole('list', { name: 'Conversas' });
    await expect(list).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Tudo' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    // The newest first: the search just made (earlier runs may have left more).
    const rows = list.getByRole('listitem').filter({ hasText: 'lei do ritmo' });
    const row = rows.first();
    await expect(row.getByText(/^Busca · /)).toBeVisible();
    // Pesquisa com IA hides the searches; Tudo brings them back.
    await page.getByRole('radio', { name: 'Pesquisa com IA' }).click();
    await expect(rows).toHaveCount(0);
    await page.getByRole('radio', { name: 'Tudo' }).click();
    // ⋯ holds Abrir and Apagar conversa, on screen.
    await row
      .first()
      .getByRole('button', { name: /^Mais opções/ })
      .click();
    const menu = page.getByRole('menu', { name: 'Opções da conversa' });
    await expectOnScreen(page, menu);
    await expect(
      menu.getByRole('menuitem', { name: 'Apagar conversa' }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await row
      .first()
      .getByRole('button', { name: /lei do ritmo/ })
      .first()
      .click();
    await expect(page.locator('app-result-card').first()).toBeVisible();
    await expect(list).toBeHidden();
    expect(errors).toEqual([]);

    await page.goto('/');
    const buscar = nav.getByRole('link', { name: 'Buscar' });
    await buscar.click();
    await expect(buscar).toHaveAttribute('aria-current', 'page');
    await expect(
      nav.getByRole('link', { name: 'Conversas' }),
    ).not.toHaveAttribute('aria-current', 'page');
  });
});

test.describe('the document page on a phone', () => {
  test.beforeEach(startInSearchView);

  test('✦ is tapped at its centre, ⋯ reaches "Sobre este documento", and the tabs stay', async ({
    page,
  }) => {
    test.skip(desktop(page), 'cmDoc is the phone layout.');
    await searchByMeaning(page, 'natureza setupla');
    await page
      .locator('app-result-card')
      .filter({ hasText: /A Natureza Sétupla/i })
      .first()
      .locator('button.card')
      .click();
    const doc = page.locator('app-document-panel');
    await expect(doc.getByRole('heading', { level: 2 })).toBeVisible();
    // The bottom navigation stays under the page (cmDoc nav: 1), not covered by it.
    await expect(page.getByRole('navigation').last()).toBeInViewport();
    const ask = doc.getByRole('button', { name: 'Perguntar à IA' });
    if (await ask.count()) {
      const box = await ask.boundingBox();
      expect(box).toBeTruthy();
      if (box) {
        const hit = await page.evaluate(
          ([x, y]) =>
            document
              .elementFromPoint(x ?? 0, y ?? 0)
              ?.closest('button')
              ?.textContent?.trim() ?? '',
          [box.x + box.width / 2, box.y + box.height / 2],
        );
        expect(hit).toContain('Perguntar à IA');
      }
    }
    await doc.getByRole('button', { name: 'Mais opções' }).click();
    const menu = page.getByRole('menu', { name: 'Mais opções do documento' });
    await expectOnScreen(page, menu);
    await menu.getByRole('menuitem', { name: 'Sobre este documento' }).click();
    await expect(menu).toBeHidden();
    await expect(
      doc.getByRole('heading', { name: 'Sobre este documento' }),
    ).toBeInViewport();
  });
});

test.describe('the collection dialog', () => {
  test('a name with no letter keeps Criar off until it is fixed; ✕ or Cancelar closes', async ({
    page,
  }) => {
    await page.goto('/');
    await startNewCollection(page);
    const dialog = page.getByRole('dialog', { name: 'Novo acervo' });
    await expect(dialog).toBeVisible();
    const create = dialog.getByRole('button', { name: 'Criar acervo' });
    // The cover waits for the collection: "Capa pela sigla" on desktop, the folder alone on
    // a phone (cmCollection).
    if (desktop(page))
      await expect(dialog.getByText('Capa pela sigla')).toBeVisible();
    else {
      await expect(dialog.locator('.initials-empty')).toBeVisible();
      await expect(dialog.getByText('Capa pela sigla')).toBeHidden();
    }
    await dialog.getByLabel('Nome').fill('!!!');
    await create.click();
    await expect(
      dialog.getByText('Escreva um nome com pelo menos uma letra ou número.'),
    ).toBeVisible();
    await expect(create).toBeDisabled();
    await dialog.getByLabel('Nome').fill('Rosacruz');
    await expect(create).toBeEnabled();
    await expect(
      dialog.getByRole('combobox', { name: 'Dentro de' }),
    ).toHaveValue('');
    await expect(
      dialog.getByRole('option', { name: 'Nenhum acervo (no topo)' }),
    ).toHaveCount(1);
    await dialog
      .getByRole('button', { name: desktop(page) ? 'Fechar' : 'Cancelar' })
      .click();
    await expect(dialog).toBeHidden();
  });
});

test.describe('the AI research', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() => localStorage.clear());
    await page.reload();
  });

  test('a citation opens its source, and the source closes back to the answer', async ({
    page,
  }) => {
    await page.getByLabel('Sua pergunta').fill('natureza sétupla');
    await page.getByRole('button', { name: 'Perguntar' }).click();
    const answer = page.locator('app-research-message').last();
    await expect(answer.getByText(/Resposta gerada por IA/)).toBeVisible();
    const cite = answer.getByRole('link', { name: /^Fonte \d+:/ }).first();
    await cite.click();
    const source = page.locator('app-document-panel');
    await expect(source.getByRole('heading', { level: 2 })).toBeVisible();
    await expectOnScreen(page, source.getByRole('heading', { level: 2 }));
    await page.keyboard.press('Escape');
    await expect(source).toBeHidden();
    await expect(answer).toBeVisible();

    // Fontes: a desktop row's ⋯ (Abrir, Copiar referência); a phone's FONTE n card.
    const row = answer.locator('button.source').first();
    if (desktop(page)) {
      await answer
        .getByRole('button', { name: /^Mais opções da fonte \d+$/ })
        .first()
        .click();
      const menu = page.getByRole('menu', { name: 'Mais opções da fonte' });
      await expectOnScreen(page, menu);
      await menu.getByRole('menuitem', { name: 'Abrir' }).click();
      await expect(source.getByRole('heading', { level: 2 })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(source).toBeHidden();
    } else {
      await expect(row.locator('.source-kicker')).toHaveText(/^FONTE \d+$/);
      await expect(answer.locator('.source-more')).toBeHidden();
      await row.click();
      await expect(source.getByRole('heading', { level: 2 })).toBeVisible();
    }
  });
});
