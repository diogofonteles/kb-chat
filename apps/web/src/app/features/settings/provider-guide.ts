import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { AiProvider } from '@kb-chat/contracts';
import { PROVIDER_GUIDES } from './provider-guides.js';

/** The step-by-step guide of one AI option (KBC-023 FR-5). Presentational. */
@Component({
  selector: 'app-provider-guide',
  template: `
    @if (guide(); as current) {
      <section class="guide" [attr.aria-label]="label()">
        <ol class="steps">
          @for (step of current.steps; track $index) {
            <li>
              {{ step.text() }}
              @if (step.link; as link) {
                <a [href]="link.href" target="_blank" rel="noopener noreferrer"
                  >{{ link.label()
                  }}<span class="visually-hidden" i18n="@@guide.newTab">
                    (abre em nova aba)</span
                  ></a
                >
              }
            </li>
          }
        </ol>
        <dl class="facts">
          <dt i18n="@@guide.cost">Quanto custa</dt>
          <dd>{{ current.cost() }}</dd>
          <dt i18n="@@guide.privacy">Privacidade</dt>
          <dd>{{ current.privacy() }}</dd>
          @if (current.limits) {
            <dt i18n="@@guide.limits">Limites</dt>
            <dd>{{ current.limits() }}</dd>
          }
        </dl>
        @if (current.note) {
          <p class="note">
            <span aria-hidden="true">ⓘ</span> {{ current.note() }}
          </p>
        }
      </section>
    }
  `,
  styles: `
    .guide {
      display: grid;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      border-radius: var(--radius-md);
      background: var(--color-surface-muted);
    }
    .steps {
      display: grid;
      gap: var(--space-2);
      margin: 0;
      padding-left: var(--space-5, 1.25rem);
    }
    .steps a {
      margin-left: var(--space-1);
      color: var(--color-accent-strong);
      overflow-wrap: anywhere;
    }
    .facts {
      display: grid;
      gap: var(--space-1);
      margin: 0;
      font-size: var(--text-sm);
    }
    .facts dt {
      font-weight: 600;
    }
    .facts dd {
      margin: 0 0 var(--space-2);
    }
    .note {
      margin: 0;
      padding: var(--space-2) var(--space-3);
      border-left: 3px solid var(--color-accent);
      font-size: var(--text-sm);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProviderGuideCard {
  readonly provider = input.required<AiProvider>();
  protected readonly guide = computed(
    () => PROVIDER_GUIDES[this.provider()] ?? null,
  );
  protected readonly label = computed(
    () => $localize`:@@guide.label:Como configurar`,
  );
}
