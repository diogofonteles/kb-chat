import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { render, screen, within } from '@testing-library/angular';
import { TUTORIAL_IMAGES } from './tutorial-images.generated.js';
import { TutorialPage } from './tutorial-page.js';
import { TUTORIAL_SECTIONS } from './tutorial-sections.js';

/** The whole page's pictures stay light enough for a phone on 4G (KBC-032 NFR-1). */
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

async function renderTutorial(url = '/tutorial') {
  const result = await render(TutorialPage, {
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([{ path: 'tutorial', children: [] }]),
    ],
  });
  await TestBed.inject(Router).navigateByUrl(url);
  await result.fixture.whenStable();
  return result;
}

const images = (container: Element): HTMLImageElement[] => [
  ...container.querySelectorAll('img'),
];

describe('TutorialPage (KBC-032)', () => {
  it('has a title and one section per table-of-contents entry, with its anchor (AC-1, AC-3)', async () => {
    const { container } = await renderTutorial();

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Como usar a Nova Alexandria',
      }),
    ).toBeTruthy();
    const toc = screen.getByRole('navigation', { name: 'Nesta página' });
    const links = within(toc).getAllByRole('link');
    expect(links.map((link) => link.textContent?.trim())).toEqual(
      TUTORIAL_SECTIONS.map((section) => section.title),
    );
    for (const [index, section] of TUTORIAL_SECTIONS.entries()) {
      expect(links[index]?.getAttribute('href')).toBe(
        `/tutorial#${section.id}`,
      );
      const heading = container.querySelector(`#${section.id}`);
      expect(heading?.tagName, section.id).toBe('H2');
      expect(heading?.textContent?.trim()).toBe(section.title);
    }
  });

  it('shows every captured picture once, each with a meaningful text alternative (AC-3)', async () => {
    const { container } = await renderTutorial();

    const shown = images(container);
    const sources = shown.map((image) => image.getAttribute('src'));
    expect([...sources].sort()).toEqual(
      Object.values(TUTORIAL_IMAGES)
        .map((image) => image.src)
        .sort(),
    );
    for (const image of shown) {
      expect(image.getAttribute('src')).toMatch(
        /^\/assets\/tutorial\/[a-z-]+-[0-9A-F]{8}\.webp$/,
      );
      expect(image.alt.length, image.src).toBeGreaterThan(30);
      expect(Number(image.getAttribute('width'))).toBeGreaterThan(0);
      expect(Number(image.getAttribute('height'))).toBeGreaterThan(0);
    }
  });

  it('marks the administrators section as only for them', async () => {
    const { container } = await renderTutorial();

    const admins = container.querySelector('section:has(#administradores)');
    expect(admins?.textContent).toContain('Só para administradores');
  });

  it('keeps the pictures under 3 MB and loads lazily all but the first ones (AC-5)', async () => {
    const { container } = await renderTutorial();

    const total = Object.values(TUTORIAL_IMAGES).reduce(
      (sum, image) => sum + image.bytes,
      0,
    );
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(MAX_IMAGE_BYTES);
    // The first picture on a desktop (home) and on a phone (login) come at once.
    const [home, login, ...rest] = images(container);
    expect(home?.getAttribute('loading')).not.toBe('lazy');
    expect(login?.getAttribute('src')).toBe(TUTORIAL_IMAGES.login.src);
    expect(login?.getAttribute('loading')).not.toBe('lazy');
    expect(rest.length).toBeGreaterThan(0);
    for (const image of rest)
      expect(image.getAttribute('loading')).toBe('lazy');
  });

  it('opens at the section of the address and moves the focus to its title (AC-2)', async () => {
    await renderTutorial('/tutorial#pesquisa-com-ia');

    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'Pesquisa com IA' }),
    );
  });

  it('moves the focus to a section chosen in the table of contents (AC-2)', async () => {
    const { fixture } = await renderTutorial();

    screen.getByRole('link', { name: 'Para administradores' }).click();
    await fixture.whenStable();

    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 2, name: 'Para administradores' }),
    );
  });

  it('links back to the app and to the privacy policy', async () => {
    await renderTutorial();

    expect(
      screen
        .getByRole('link', { name: 'Voltar à Nova Alexandria' })
        .getAttribute('href'),
    ).toBe('/');
    expect(
      screen
        .getByRole('link', { name: 'Política de privacidade' })
        .getAttribute('href'),
    ).toBe('/privacidade');
  });
});
