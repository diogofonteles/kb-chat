import { ChangeDetectionStrategy, Component } from '@angular/core';
import { UiLogo } from '@ui/logo.js';

/**
 * "Carregando…" while the app decides who is signed in (v2 · Auth, auth-boot): the logo with
 * rings that pulse, over the entry screen's gradient. Still under reduced motion.
 */
@Component({
  selector: 'app-boot-screen',
  imports: [UiLogo],
  template: `
    <div class="pulse" aria-hidden="true">
      <span class="ring outer"></span>
      <span class="ring inner"></span>
      <ui-logo [size]="64" />
    </div>
    <p class="text" role="status" i18n="@@app.loading">Carregando…</p>
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: var(--space-5);
      min-height: 100dvh;
      background:
        linear-gradient(
            180deg,
            color-mix(in srgb, var(--color-accent) 38%, var(--color-shell)) 0,
            var(--color-shell) 60%
          )
          no-repeat,
        var(--color-shell);
      color: var(--color-text-muted);
    }
    .pulse {
      position: relative;
      display: grid;
      place-items: center;
      width: 10rem;
      height: 10rem;
    }
    .ring {
      position: absolute;
      border-radius: 50%;
      background: color-mix(in srgb, var(--color-accent) 10%, transparent);
      animation: pulse 1.6s var(--ease) infinite;
    }
    .outer {
      inset: 0;
    }
    .inner {
      inset: 1.5rem;
      background: color-mix(in srgb, var(--color-accent) 18%, transparent);
      animation-delay: 0.2s;
    }
    .text {
      margin: 0;
      font-size: var(--text-item);
    }
    @keyframes pulse {
      50% {
        transform: scale(0.92);
        opacity: 0.6;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BootScreen {}
