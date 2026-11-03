// KBC-049 local validation: the upload's "Autor" combobox (suggestions and "Cadastrar «nome»"),
// the media badges and the "Autoria" filter of a new "UDV", and the documents' "Autoria" control
// with "✦ Mestre Laércio" in the Hermetismo, at 1440 and 390 px, on the E2E servers.
// Usage: node e2e/tools/local-validation-authors.mjs http://localhost:4349 <dir>
import { chromium } from '@playwright/test';

const [base, out] = process.argv.slice(2);
const CSRF = { 'x-requested-with': 'kb-chat' };
const browser = await chromium.launch();

async function signIn(request) {
  const token = await request.post('/api/e2e/token', {
    data: { email: 'owner@kb-chat.test' },
    headers: CSRF,
  });
  const { credential } = await token.json();
  await request.post('/api/v1/auth/google', {
    data: { credential },
    headers: CSRF,
  });
}

const admin = await browser.newContext({ baseURL: base });
await signIn(admin.request);
const post = async (url, data) =>
  (await admin.request.post(url, { data, headers: CSRF })).json();
const tag = Date.now().toString(36);
const { slug } = await post('/api/v1/topics', { title: `UDV ${tag}` });
await post('/api/v1/topics', { title: 'Palavra do Mestre', parent: slug });
const authors = `/api/v1/topics/${encodeURIComponent(slug)}/authors`;
for (const name of ['Mestre Gabriel', 'Ana Souza', 'José Gabriel da Costa'])
  await post(authors, { name });
await admin.request.patch(`/api/v1/topics/${encodeURIComponent(slug)}`, {
  data: { mainAuthor: 'mestre-gabriel' },
  headers: CSRF,
});
for (const [title, author] of [
  ['Sessão de escala — a burracheira', 'mestre-gabriel'],
  ['Histórico do Centro contado por Ana', 'ana-souza'],
  ['Gravação sem autor informado', null],
])
  await post(`/api/v1/topics/${encodeURIComponent(slug)}/media`, {
    title,
    author,
    fileName: 'a.mp3',
    bytes: 1000,
  });

const report = [];
const overflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
for (const width of [1440, 390]) {
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width, height: width > 1000 ? 900 : 844 },
  });
  await signIn(context.request);
  const page = await context.newPage();
  const phone = width < 1000;
  const menu = async () => {
    if (phone)
      await page.getByRole('button', { name: 'Menu', exact: true }).click();
  };
  await page.goto('/');
  await page.getByLabel('Sua pergunta').waitFor();
  await menu();
  await page
    .getByRole('combobox', { name: 'Acervo', exact: true })
    .selectOption({ value: slug });
  if (phone) await page.keyboard.press('Escape');
  // "Editar acervo" with its "Autor principal" (the coordinator's gap 1).
  await menu();
  await page.getByRole('button', { name: 'Editar acervo' }).click();
  const edit = page.getByRole('dialog', { name: 'Editar acervo' });
  await edit
    .getByRole('combobox', { name: 'Autor principal' })
    .locator('option', { hasText: 'Ana Souza' })
    .waitFor({ state: 'attached' });
  await page.screenshot({
    path: `${out}/edit-collection-main-author-${width}.png`,
  });
  report.push(`${width} edit dialog overflow ${await overflow(page)}`);
  await edit.getByRole('button', { name: 'Cancelar' }).click();
  if (phone) await page.keyboard.press('Escape');
  await menu();
  await page.getByRole('link', { name: 'Mídia' }).click();
  await page.getByRole('heading', { name: /Mídia — UDV/ }).waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${out}/media-badges-filter-${width}.png` });
  report.push(`${width} list overflow ${await overflow(page)}`);

  await page.getByRole('button', { name: 'Enviar áudio' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Enviar áudio' });
  const field = dialog.getByRole('combobox', { name: 'Autor' });
  await field.focus();
  await page.keyboard.press('ArrowDown');
  await dialog.getByRole('listbox').getByRole('option').first().waitFor();
  await field.scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${out}/upload-author-suggestions-${width}.png`,
  });
  await field.fill('Mestre Pedro');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/upload-author-register-${width}.png` });
  report.push(`${width} dialog overflow ${await overflow(page)}`);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  await page.addInitScript(() =>
    localStorage.setItem('kb-chat.view', 'search'),
  );
  await page.goto('/');
  await menu();
  await page
    .getByRole('combobox', { name: 'Acervo', exact: true })
    .selectOption({ value: 'hermetismo' });
  if (phone) await page.keyboard.press('Escape');
  await page
    .getByLabel('Como buscar')
    .selectOption({ label: 'Por significado' });
  await page.getByLabel('Sua pergunta').fill('natureza');
  await page.getByRole('button', { name: 'Buscar' }).click();
  await page.getByRole('radiogroup', { name: 'Autoria' }).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/search-authorship-${width}.png` });
  report.push(`${width} search overflow ${await overflow(page)}`);
  await context.close();
}
console.log(report.join('\n'));
await browser.close();
