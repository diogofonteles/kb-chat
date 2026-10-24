// Visible end-to-end walkthrough on the real vault (headed, slow motion) for the owner to watch.
import { chromium, expect } from '@playwright/test';

const BASE = process.argv[2] ?? 'http://localhost:4201';
const step = (text) => console.log(`▶ ${text}`);
const browser = await chromium.launch({ headless: false, slowMo: 450 });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

step('Abrir o kb-chat');
await page.goto(BASE);
await expect(page.getByText('O que você quer estudar hoje?')).toBeVisible();

step('Perguntar no modo "Tudo"');
await page
  .getByLabel('Sua pergunta')
  .pressSequentially('como se proteger de energias negativas', { delay: 40 });
await page.keyboard.press('Enter');
await expect(page.locator('app-result-card').first()).toBeVisible();
await expect(page.getByText(/documentos · Tudo/)).toBeVisible();

step('Filtrar por assunto pelo chip');
await page.getByRole('button', { name: /^Assuntos/ }).click();
await page
  .getByRole('checkbox', { name: /Forças Negativas e Proteção/ })
  .check();
await page.keyboard.press('Escape');
await expect(
  page.getByRole('button', {
    name: 'Remover Assuntos: Forças Negativas e Proteção',
  }),
).toBeVisible();

step('Abrir o primeiro documento e navegar pelas ocorrências');
await page
  .locator('app-result-card')
  .first()
  .getByRole('button')
  .first()
  .click();
const panel = page.getByRole('dialog');
await expect(panel.getByRole('heading', { level: 2 })).toBeVisible();
const next = panel.getByRole('button', { name: 'Próxima ocorrência' });
if (await next.isVisible()) {
  await next.click();
  await next.click();
}

step('Abrir um conceito em "Veja também" e voltar');
const ref = panel.locator('app-see-also button.ref').first();
if (await ref.isVisible()) {
  await ref.scrollIntoViewIfNeeded();
  await ref.click();
  await expect(panel.getByRole('button', { name: '← Voltar' })).toBeVisible();
  await page.waitForTimeout(1200);
  await panel.getByRole('button', { name: '← Voltar' }).click();
}

step('Fechar o painel e trocar para "Palavras exatas"');
await page.keyboard.press('Escape');
await page.getByLabel('Como buscar').selectOption({ label: 'Palavras exatas' });
await page
  .getByLabel('Sua pergunta')
  .pressSequentially('natureza sétupla', { delay: 40 });
await page.keyboard.press('Enter');
await expect(page.getByText(/Palavras exatas ·/)).toBeVisible();

step('Expandir cópias de um resultado agrupado');
const copies = page.getByRole('button', { name: /\+\d+ cópias?/ }).first();
if (await copies.isVisible()) await copies.click();

step('Celular (390 px): tela de filtros com Aplicar');
await page.setViewportSize({ width: 390, height: 844 });
await page
  .getByRole('button', { name: /^Filtros/ })
  .last()
  .click();
const sheet = page.getByRole('dialog', { name: 'Filtros' });
await expect(sheet).toBeVisible();
await sheet.getByRole('checkbox').first().check();
await sheet.getByRole('button', { name: 'Aplicar' }).click();
await page.waitForTimeout(1500);

step('Pronto: fluxo completo sem erros');
await page.waitForTimeout(2500);
await browser.close();
