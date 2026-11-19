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
        @if (!factsOnly() && current.ready) {
          <div class="ready">
            @for (step of current.steps; track $index) {
              @if ($first) {
                <p class="ready-line">
                  <ui-icon name="checkcircle" [size]="18" />
                  <span>{{ step.text() }}</span>
                </p>
              } @else {
                <p class="ready-note">{{ step.text() }}</p>
              }
            }
          </div>
        } @else if (!factsOnly()) {
          <ol class="steps">
            @for (step of current.steps; track $index) {
              <li>
                <span class="step-n" aria-hidden="true">{{ $index + 1 }}</span>
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
              <dd>
                {{ current.limits() }}
                @if (current.limitsMore && !factsOnly()) {
                  {{ current.limitsMore() }}
                }
              </dd>
            </div>
          }
        </dl>
        @if (current.note && !factsOnly()) {
          <p class="note">
            <ui-icon name="info" [size]="20" />
            <span>{{ current.note() }}</span>
          </p>
        }
      </section>
    }
  `,
  styles: `
    /* v2 · Sua IA: the steps 14/20, 14 apart, their numbers as words in the green dot; 20 to
       the facts. */
    .guide {
      display: grid;
      gap: 1.25rem;
    }
    .steps {
      display: grid;
      gap: 0.875rem;
      margin: 0;
      padding: 0;
      list-style: none;
      font-size: var(--text-sm);
      line-height: 1.25rem;
    }
    .steps li {
      position: relative;
      padding-left: 2.25rem;
    }
    .steps .step-n {
      position: absolute;
      top: 0;
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
    /* Nothing to set up: ✓ 18 and the words 14/17 in 700, 16 to the note 13/19, 16 to the facts. */
    .ready {
      display: grid;
      gap: var(--space-4);
      margin-bottom: -0.25rem;
    }
    .ready-line {
      display: flex;
      align-items: center;
      gap: 0.625rem;
      margin: 0;
      font-size: var(--text-sm);
      font-weight: 700;
      line-height: 1.0625rem;
    }
    .ready-line ui-icon {
      flex: none;
      color: var(--color-accent);
    }
    .ready-note {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-meta);
      line-height: 1.1875rem;
    }
    /* Cost, privacy and limits: three cards 10 apart, each as tall as its words. */
    .facts {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
      align-items: start;
      gap: 0.625rem;
      margin: 0;
    }
    .fact {
      display: grid;
      align-content: start;
      gap: 0.375rem;
      padding: 0.875rem;
      border-radius: var(--radius-card);
      background: var(--overlay-2);
      font-size: var(--text-meta);
    }
    .fact dt {
      font-weight: 700;
      line-height: 1rem;
    }
    .fact dd {
      margin: 0;
      color: var(--color-text-muted);
      line-height: 1.125rem;
    }
    /* The frame's info banner: blue tint, icon in blue, the text in 600. */
    .note {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin: 0;
      padding: 0.875rem var(--space-4);
      border-radius: var(--radius-card);
      background: color-mix(in srgb, var(--color-info) 12%, transparent);
      font-size: var(--text-sm);
      font-weight: 600;
      line-height: 1.0625rem;
    }
    .note ui-icon {
      flex: none;
      color: var(--color-info);
    }
    /* A phone: the steps 10 apart (v2 · Sua IA, celular). */
    @media (max-width: 1023px) {
      .steps {
        gap: 0.625rem;
      }
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
