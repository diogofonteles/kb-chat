import { NgOptimizedImage } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
} from '@angular/core';
import { UiIcon } from '@ui/icon.js';
import {
  TUTORIAL_IMAGES,
  type TutorialImageName,
} from './tutorial-images.generated.js';

/**
 * A screenshot of the tutorial (KBC-032) with its caption. The numbered marks are drawn on
 * the image by the capture script; the caption and the steps say the same in text, so the
 * image is never the only way (WCAG 1.1.1). Lazy unless `priority` (the first one).
 */
@Component({
  selector: 'app-tutorial-figure',
  imports: [NgOptimizedImage, UiIcon],
  template: `
    <figure [class.phone]="phone()" [class.portrait]="portrait()">
      <img
        [ngSrc]="image().src"
        [width]="image().width"
        [height]="image().height"
        [alt]="alt()"
        [priority]="priority()"
      />
      <figcaption>
        <ng-content />
        <a class="zoom" [href]="image().src" target="_blank" rel="noopener"
          ><ui-icon name="expand" [size]="14" /><ng-container
            i18n="@@tutorial.zoom"
            >Ver a imagem ampliada</ng-container
          ><span class="visually-hidden" i18n="@@tutorial.newTab">
            (abre em nova aba)</span
          ></a
        >
      </figcaption>
    </figure>
  `,
  styles: `
    /* A picture in a card with its caption and "Ver a imagem ampliada" (v2 · Públicas). */
    figure {
      display: grid;
      gap: var(--space-3);
      margin: var(--space-4) 0 var(--space-6);
      padding: 0.875rem;
      border-radius: 10px;
      background: var(--overlay-1);
    }

    img {
      display: block;
      width: 100%;
      height: auto;
      border: 1px solid var(--overlay-line);
      border-radius: var(--radius-card);
      background: var(--color-shell);
    }

    /* A tall picture (a phone, the sidebar) keeps a readable size instead of the column's. */
    .portrait img {
      width: min(100%, 20rem);
      margin: 0 auto;
    }

    .phone img {
      border-radius: var(--radius-lg);
    }

    figcaption {
      display: grid;
      gap: var(--space-1);
      font-family: var(--font-ui);
      font-size: var(--text-sm);
      line-height: 1.45;
      color: var(--color-text-muted);
    }

    .portrait figcaption {
      text-align: center;
    }

    .zoom {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      justify-self: start;
      min-height: var(--target);
      color: var(--color-accent);
      font-size: var(--text-meta);
      font-weight: 700;
      text-decoration: none;
    }

    .portrait .zoom {
      justify-self: center;
    }

    .zoom:hover {
      text-decoration: underline;
    }

    @media (max-width: 1023px) {
      figure {
        padding: 0.625rem;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TutorialFigure {
  readonly name = input.required<TutorialImageName>();
  /** What the image shows, for screen readers; never empty. */
  readonly alt = input.required<string>();
  /** The first figure: loads at once instead of lazily (largest paint). */
  readonly priority = input(false, { transform: booleanAttribute });
  /** A phone screenshot: rounder corners, like the phone (tall pictures are narrower). */
  readonly phone = input(false, { transform: booleanAttribute });

  protected readonly image = computed(() => TUTORIAL_IMAGES[this.name()]);
  protected readonly portrait = computed(
    () => this.image().height > this.image().width,
  );
}
