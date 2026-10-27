import { NgOptimizedImage } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  booleanAttribute,
  computed,
  input,
} from '@angular/core';
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
  imports: [NgOptimizedImage],
  template: `
    <figure [class.phone]="phone()">
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
          ><ng-container i18n="@@tutorial.zoom"
            >Ver a imagem ampliada</ng-container
          ><span class="visually-hidden" i18n="@@tutorial.newTab">
            (abre em nova aba)</span
          ></a
        >
      </figcaption>
    </figure>
  `,
  styles: `
    figure {
      margin: var(--space-4) 0 var(--space-6);
    }

    img {
      display: block;
      width: 100%;
      height: auto;
      border: 1px solid var(--color-border);
      border-radius: var(--radius-md);
      box-shadow: var(--shadow);
      background: var(--color-surface);
    }

    .phone img {
      width: min(100%, 20rem);
      margin: 0 auto;
      border-radius: var(--radius-lg);
    }

    figcaption {
      margin-top: var(--space-2);
      font-family: var(--font-ui);
      font-size: var(--text-sm);
      line-height: 1.5;
      color: var(--color-text-muted);
    }

    .phone figcaption {
      text-align: center;
    }

    .zoom {
      display: inline-flex;
      align-items: center;
      min-height: var(--target);
      margin-left: var(--space-1);
      color: var(--color-accent-strong);
      text-underline-offset: 2px;
    }

    .zoom:focus-visible {
      outline: 2px solid var(--color-focus);
      outline-offset: 2px;
      border-radius: var(--radius-sm);
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
  /** A phone screenshot: shown narrower and centered. */
  readonly phone = input(false, { transform: booleanAttribute });

  protected readonly image = computed(() => TUTORIAL_IMAGES[this.name()]);
}
