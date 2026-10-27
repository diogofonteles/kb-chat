import { createHash } from 'node:crypto';
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  APIRequestContext,
  Browser,
  Locator,
  Page,
} from '@playwright/test';

/**
 * Helpers of the tutorial's screenshots (KBC-032): numbered marks drawn over the app before
 * the capture, WebP conversion in Chromium's own canvas (no image dependency), hashed file
 * names (cached for a year by Caddy) and the generated manifest the page reads.
 */
const WEB_DIR = fileURLToPath(new URL('../../apps/web/', import.meta.url));
export const OUT_DIR = join(WEB_DIR, 'public/assets/tutorial');
const MANIFEST = join(
  WEB_DIR,
  'src/app/features/tutorial/tutorial-images.generated.ts',
);
const PUBLIC_PREFIX = '/assets/tutorial';
const WEBP_QUALITY = 0.8;
/** How far from the picture's edge a mark starts, so its number is never cut. */
const EDGE = 22;
export const CSRF = { 'x-requested-with': 'kb-chat' };

/** A numbered highlight drawn around an element; the number matches a step in the text. */
export interface Mark {
  readonly n: number;
  readonly target: Locator;
}

interface Box {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

interface Shot {
  readonly src: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
}

/** Signs `api` in as a fictitious person (an `@exemplo.test` address, never a real one). */
export async function signIn(
  api: APIRequestContext,
  email: string,
  name: string,
): Promise<void> {
  const token = await api.post('/api/e2e/token', {
    data: { email, name },
    headers: CSRF,
  });
  const { credential } = (await token.json()) as { credential: string };
  const response = await api.post('/api/v1/auth/google', {
    data: { credential },
    headers: CSRF,
  });
  if (response.status() !== 200)
    throw new Error(`sign-in of ${email}: ${response.status()}`);
}

/**
 * Google's button, imitated for the pictures: the real script never loads here. Its click
 * signs in `window.__kbE2eEmail` through the E2E server's test identity.
 */
const FAKE_GIS = `
window.google = { accounts: { id: {
  initialize(options) { this.options = options; },
  renderButton(parent) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Fazer login com o Google';
    button.style.cssText = 'min-height:40px;padding:0 16px;border:1px solid #dadce0;border-radius:20px;background:#fff;color:#1f1f1f;font:500 14px/1 Inter,system-ui,sans-serif;cursor:pointer';
    parent.replaceChildren(button);
  },
  disableAutoSelect() {},
} } };
`;

export async function fakeGoogle(page: Page): Promise<void> {
  await page.route('https://accounts.google.com/**', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: FAKE_GIS }),
  );
}

/** Waits until nothing animates, so the marks sit where the elements end up. */
export async function settled(page: Page): Promise<void> {
  // Twice, a few frames apart: a transition may start right after the first check.
  for (let round = 0; round < 2; round += 1) {
    await page.waitForFunction(() => document.getAnimations().length === 0);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let frames = 0;
          const tick = () =>
            ++frames >= 6 ? resolve() : requestAnimationFrame(tick);
          requestAnimationFrame(tick);
        }),
    );
  }
}

async function drawMarks(
  page: Page,
  marks: readonly Mark[],
  frame: Box | null,
): Promise<void> {
  const boxes: (Box & { n: number })[] = [];
  for (const mark of marks) {
    if (mark.n < 1 || mark.n > 9)
      throw new Error(`mark ${mark.n}: use 1 to 9 (A to I)`);
    const box = await mark.target.boundingBox({ timeout: 10_000 });
    if (!box) throw new Error(`mark ${mark.n} is not on the screen`);
    // Kept inside the picture, so the number in the corner is never cut.
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const right = (frame ? frame.x + frame.width : viewport.width) - EDGE;
    const x = Math.max(box.x, (frame?.x ?? 0) + 8);
    const y = Math.max(box.y, (frame?.y ?? 0) + EDGE);
    boxes.push({
      x,
      y,
      width: Math.min(box.x + box.width, right) - x,
      height: box.height - (y - box.y),
      n: mark.n,
    });
  }
  await page.evaluate((items) => {
    // A popover is in the top layer, above an open modal <dialog> (Settings).
    const layer = document.createElement('div');
    layer.id = 'tutorial-marks';
    layer.popover = 'manual';
    layer.style.cssText =
      'position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none';
    for (const item of items) {
      const box = document.createElement('div');
      box.style.cssText = `position:absolute;left:${item.x - 5}px;top:${item.y - 5}px;width:${item.width + 10}px;height:${item.height + 10}px;box-sizing:border-box;border:3px solid #c2410c;border-radius:12px;box-shadow:0 0 0 2px #fff`;
      const badge = document.createElement('div');
      // Letters, not numbers: the numbered steps in the text are another thing.
      badge.textContent = 'ABCDEFGHI'.charAt(item.n - 1);
      badge.style.cssText =
        'position:absolute;right:-15px;top:-15px;width:28px;height:28px;border-radius:7px;background:#1f1e1c;color:#fff;font:700 15px/28px Inter,system-ui,sans-serif;text-align:center;box-shadow:0 0 0 2px #fff';
      box.append(badge);
      layer.append(box);
    }
    document.body.append(layer);
    layer.showPopover();
  }, boxes);
}

async function clearMarks(page: Page): Promise<void> {
  await page.evaluate(() =>
    document.getElementById('tutorial-marks')?.remove(),
  );
}

/** Collects the screenshots, converts them and writes the files and the manifest. */
export class Shooter {
  private readonly shots = new Map<string, Shot>();
  private readonly files = new Map<string, Buffer>();

  constructor(private readonly converter: Page) {}

  static async create(browser: Browser): Promise<Shooter> {
    return new Shooter(await browser.newPage());
  }

  /**
   * Captures `page` (or the `clip` region, in CSS pixels) with the marks drawn, as
   * `<name>-<HASH>.webp`.
   */
  async shoot(
    page: Page,
    name: string,
    options: {
      readonly marks?: readonly Mark[];
      readonly clip?: Locator;
      /** False for a passing state (a sweep's progress) that would end while settling. */
      readonly settle?: boolean;
      /** Page space kept around `clip`, so a mark at its edge never covers the content. */
      readonly margin?: number;
    } = {},
  ): Promise<void> {
    if (options.settle !== false) await settled(page);
    // No focus ring in the pictures (the composer takes the focus on load).
    await page.evaluate(() =>
      (document.activeElement as HTMLElement | null)?.blur(),
    );
    const clip = options.clip
      ? await this.clipOf(page, options.clip, options.margin ?? 0)
      : null;
    await drawMarks(page, options.marks ?? [], clip);
    const png = await page.screenshot({
      animations: 'disabled',
      caret: 'hide',
      ...(clip ? { clip } : {}),
    });
    await clearMarks(page);
    const webp = await this.toWebp(png);
    const hash = createHash('sha256')
      .update(webp.data)
      .digest('hex')
      .slice(0, 8)
      .toUpperCase();
    const file = `${name}-${hash}.webp`;
    // Written at the end: a file in public/ mid-run would reload the dev server's pages.
    this.files.set(file, webp.data);
    this.shots.set(name, {
      src: `${PUBLIC_PREFIX}/${file}`,
      width: webp.width,
      height: webp.height,
      bytes: webp.data.length,
    });
  }

  /** Writes the pictures, removes the old ones and regenerates the manifest. */
  finish(): void {
    for (const file of readdirSync(OUT_DIR))
      if (file.endsWith('.webp') && !this.files.has(file))
        rmSync(join(OUT_DIR, file));
    for (const [file, data] of this.files)
      writeFileSync(join(OUT_DIR, file), data);
    writeFileSync(MANIFEST, this.manifest());
  }

  private async clipOf(
    page: Page,
    target: Locator,
    margin: number,
  ): Promise<Box> {
    const box = await target.boundingBox({ timeout: 10_000 });
    if (!box) throw new Error('the clip region is not on the screen');
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('no viewport');
    // With the margin, inside the viewport, in whole pixels.
    const x = Math.max(0, Math.floor(box.x - margin));
    const y = Math.max(0, Math.floor(box.y - margin));
    return {
      x,
      y,
      width: Math.min(
        viewport.width - x,
        Math.ceil(box.x + box.width + margin) - x,
      ),
      height: Math.min(
        viewport.height - y,
        Math.ceil(box.y + box.height + margin) - y,
      ),
    };
  }

  private async toWebp(
    png: Buffer,
  ): Promise<{ data: Buffer; width: number; height: number }> {
    const encoded = await this.converter.evaluate(
      async ({ base64, quality }) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext('2d')?.drawImage(image, 0, 0);
        return {
          data: canvas.toDataURL('image/webp', quality).split(',')[1] ?? '',
          width: canvas.width,
          height: canvas.height,
        };
      },
      { base64: png.toString('base64'), quality: WEBP_QUALITY },
    );
    return { ...encoded, data: Buffer.from(encoded.data, 'base64') };
  }

  private manifest(): string {
    const entries = [...this.shots.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([name, shot]) =>
          `  '${name}': {\n    src: '${shot.src}',\n    width: ${shot.width},\n    height: ${shot.height},\n    bytes: ${shot.bytes},\n  },`,
      );
    return [
      '// Generated by `pnpm tutorial:screenshots` (e2e/tutorial/capture.ts). Do not edit.',
      '',
      'export interface TutorialImage {',
      '  readonly src: string;',
      '  readonly width: number;',
      '  readonly height: number;',
      '  readonly bytes: number;',
      '}',
      '',
      'export const TUTORIAL_IMAGES = {',
      ...entries,
      '} as const satisfies Record<string, TutorialImage>;',
      '',
      'export type TutorialImageName = keyof typeof TUTORIAL_IMAGES;',
      '',
    ].join('\n');
  }
}

/**
 * Scrolls the nearest scrolling box (a dialog's content) so that `target` starts at its top,
 * without moving the dialog itself as `scrollIntoView` may.
 */
export async function scrollToTop(target: Locator): Promise<void> {
  await target.evaluate((element) => {
    let box = element.parentElement;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY))
      box = box.parentElement;
    if (!box) return;
    const offset =
      element.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop += offset - 16;
  });
}
