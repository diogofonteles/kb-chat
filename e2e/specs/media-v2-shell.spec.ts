import AxeBuilder from '@axe-core/playwright';
import { expect, ownerApi, test } from './fixtures.js';
import {
  audioState,
  newListener,
  uniqueTag,
  uploadReady,
} from './media-helpers.js';
import { desktop, library } from './shell-helpers.js';

/** KBC-125 AC-3 (FR-3): the player bar keeps the sound across routes (in Google Chrome). */
const shots = process.env['KBC_SHOTS'];

test('AC-3: a sound playing goes on from the library to the conversation, with the player bar', async ({
  browser,
  viewport,
}) => {
  test.setTimeout(180_000);
  const owner = await ownerApi();
  const lecture = await uploadReady(owner, {
    title: `Aula da casca v2 ${uniqueTag()}`,
    seconds: 120,
  });
  await owner.dispose();
  // A listener of Hermetismo (KBC-041): positions and speed are per person.
  const { page } = await newListener(browser, { viewport });
  await page.goto(`/midia/${lecture.id}`);
  await page.getByRole('button', { name: 'Tocar' }).click();
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(0.5);
  const elements = () =>
    page.evaluate(() => document.querySelectorAll('audio, video').length);
  const before = await elements();
  // To the library, then to the conversation: two routes, the same element.
  const side = await library(page);
  await side.getByRole('link', { name: /^(Biblioteca|Mídia)$/ }).click();
  if (desktop(page)) await page.getByRole('button', { name: 'Início' }).click();
  else {
    await page
      .getByRole('navigation', { name: 'Navegação' })
      .getByRole('link', { name: 'Conversas' })
      .click();
  }
  await expect(page.getByLabel('Sua pergunta')).toBeVisible();
  const bar = page.getByRole('region', { name: 'Mini-player' });
  await expect(bar).toBeVisible();
  await expect(bar.getByRole('link', { name: lecture.title })).toBeVisible();
  const at = (await audioState(page)).currentTime;
  await expect
    .poll(async () => (await audioState(page)).currentTime)
    .toBeGreaterThan(at);
  expect(await elements()).toBe(before);
  if (shots)
    await page.screenshot({
      path: `${shots}/shell-player-${page.viewportSize()?.width}.png`,
    });
  const { violations } = await new AxeBuilder({ page }).analyze();
  expect(
    violations.filter((v) => v.impact === 'serious' || v.impact === 'critical'),
  ).toEqual([]);
  await page.context().close();
});
