import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { AiProvider } from '@kb-chat/contracts';
import { UiIcon } from '@ui/index.js';
import { PROVIDER_COPY } from './provider-copy.js';
import { PROVIDER_GUIDES } from './provider-guides.js';

/** The step-by-step guide of one AI option (KBC-023 FR-5). Presentational. */
@Component({
  selector: 'app-provider-guide',
  imports: [UiIcon],
  template: `
    @if (guide(); as current) {
      <section class="guide" [attr.aria-label]="label()">
        @if (!factsOnly()) {
          <ol class="steps">
            @for (step of current.steps; track $index) {
              <li>
                {{ step.text() }}
                @if (step.link; as link) {
                  <a
                    [href]="link.href"
                    target="_blank"
                    rel="noopener noreferrer"
                    >{{ link.label()
                    }}<span class="visually-hidden" i18n="@@guide.newTab">
                      (abre em nova aba)</span
                    ></a
                  >
                }
              </li>
            }
          </ol>
        }
        <dl class="facts">
          <div class="fact">
            <dt i18n="@@guide.cost">Quanto custa</dt>
            <dd>{{ current.cost() }}</dd>
          </div>
          <div class="fact">
            <dt i18n="@@guide.privacy">Privacidade</dt>
            <dd>{{ current.privacy() }}</dd>
          </div>
          @if (current.limits) {
            <div class="fact">
              <dt i18n="@@guide.limits">Limites</dt>
              <dd>{{ current.limits() }}</dd>
            </div>
          }
        </dl>
        @if (current.note && !factsOnly()) {
          <p class="note">
            <ui-icon name="info" [size]="18" />
            <span>{{ current.note() }}</span>
          </p>
        }
      </section>
    }
  `,
  styles: `
    .guide {
      display: grid;
      gap: var(--space-4);
    }
    .steps {
      display: grid;
      gap: var(--space-3);
      margin: 0;
      padding: 0;
      list-style: none;
      counter-reset: step;
      font-size: var(--text-sm);
      line-height: 1.45;
    }
    .steps li {
      position: relative;
      padding-left: 2.25rem;
      counter-increment: step;
    }
    .steps li::before {
      content: counter(step);
      position: absolute;
      top: -0.0625rem;
      left: 0;
      display: grid;
      place-items: center;
      width: 1.5rem;
      height: 1.5rem;
      border-radius: var(--radius-pill);
      background: var(--color-accent);
      color: var(--color-on-accent);
      font-size: var(--text-xs);
      font-weight: 800;
    }
    .steps a {
      margin-left: var(--space-1);
      color: var(--color-accent-text);
      overflow-wrap: anywhere;
    }
    .facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
      gap: var(--space-3);
      margin: 0;
    }
    .fact {
      display: grid;
      align-content: start;
      gap: var(--space-2);
      padding: 0.875rem;
      border-radius: var(--radius-card);
      background: var(--overlay-2);
      font-size: var(--text-meta);
    }
    .fact dt {
      font-weight: 700;
    }
    .fact dd {
      margin: 0;
      color: var(--color-text-muted);
      line-height: 1.4;
    }
    /* The frame's info banner: blue tint, icon in blue, the text in 600. */
    .note {
      display: flex;
      align-items: flex-start;
      gap: var(--space-3);
      margin: 0;
      padding: var(--space-3) var(--space-4);
      border-radius: var(--radius-card);
      background: color-mix(in srgb, var(--color-info) 12%, transparent);
      font-size: var(--text-sm);
      font-weight: 600;
      line-height: 1.45;
    }
    .note ui-icon {
      flex: none;
      color: var(--color-info);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProviderGuideCard {
  readonly provider = input.required<AiProvider>();
  /** Only cost, privacy and limits: an option with nothing to set up (the wizard's house AI). */
  readonly factsOnly = input(false);
  protected readonly guide = computed(
    () => PROVIDER_GUIDES[this.provider()] ?? null,
  );
  protected readonly label = computed(
    () =>
      $localize`:@@guide.label:Como configurar: ${PROVIDER_COPY[this.provider()].name()}:provider:`,
  );
}
