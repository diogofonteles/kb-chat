import { formatDate, formatNumber } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  webSearchSettingsSchema,
  type WebSearchSettings,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import {
  WebSearchApi,
  webSearchSettingsUrl,
} from '@core/web-search/web-search-api.js';
import { UiBanner, UiIcon, UiProgress } from '@ui/index.js';
import type { Observable } from 'rxjs';

/** What the status line says after an action (UP-01), in words, never by color alone. */
interface Notice {
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

/**
 * "Pesquisa na web (Firecrawl)" (KBC-185; masters): connect the house's key (tested first,
 * sealed, never shown again but its last 4 characters), see the balance and remove the key.
 */
@Component({
  selector: 'app-web-search-settings',
  imports: [UiBanner, UiIcon, UiProgress],
  templateUrl: './web-search-settings.html',
  styleUrls: [
    '../settings/settings-form.css',
    '../transcribers/transcribers-panel.css',
    '../transcribers/groq-panel.css',
    './web-search-settings.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WebSearchSettingsPanel {
  private readonly api = inject(WebSearchApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);
  private readonly injector = inject(Injector);
  private readonly keyInput =
    viewChild<ElementRef<HTMLInputElement>>('keyInput');

  protected readonly loaded = httpResource(() => webSearchSettingsUrl(), {
    parse: (body) => webSearchSettingsSchema.parse(body),
  });
  /** The last view the API gave: the page's, or a write's answer. */
  protected readonly settings = linkedSignal<WebSearchSettings | null>(() =>
    this.loaded.hasValue() ? this.loaded.value() : null,
  );
  protected readonly key = signal('');
  protected readonly busy = signal(false);
  protected readonly notice = signal<Notice | null>(null);
  /** The balance in its parts: "994" big, "de 1.000 créditos até 15/12" small, a bar. */
  protected readonly balance = computed(() => {
    const credits = this.settings()?.credits;
    if (!credits) return null;
    const { remaining, plan } = credits;
    // Credits bought apart pass the plan's: "1.200 de 1.000" would say nothing.
    const ofPlan = plan !== null && plan >= remaining && plan > 0;
    return {
      remaining: this.count(remaining),
      rest: this.restOf(ofPlan ? plan : null, credits.periodEnd),
      share: ofPlan ? remaining / plan : null,
    };
  });
  protected readonly describedBy = computed(() =>
    this.notice()
      ? 'web-search-key-status web-search-key-hint'
      : 'web-search-key-hint',
  );

  protected editKey(event: Event): void {
    this.key.set((event.target as HTMLInputElement).value);
  }

  /** "Testar e salvar": kept only when Firecrawl accepts it. */
  protected save(event: Event): void {
    event.preventDefault();
    const key = this.key().trim();
    if (!key) {
      this.notice.set({
        kind: 'error',
        text: $localize`:@@webSearch.settings.noKey:Cole a chave do Firecrawl antes de testar.`,
      });
      this.keyInput()?.nativeElement.focus();
      return;
    }
    this.run(this.api.connect(key), (settings) => {
      this.settings.set(settings);
      this.key.set('');
      this.notice.set({
        kind: 'ok',
        text: $localize`:@@webSearch.settings.saved:Chave aceita e salva.`,
      });
    });
  }

  protected remove(): void {
    this.run(this.api.disconnect(), (settings) => {
      this.settings.set(settings);
      this.notice.set({
        kind: 'ok',
        text: $localize`:@@webSearch.settings.removed:Chave removida. A pesquisa na web está desligada.`,
      });
      // "Remover chave" went with the key: the focus goes to the field (WCAG 2.4.3).
      afterNextRender(() => this.keyInput()?.nativeElement.focus(), {
        injector: this.injector,
      });
    });
  }

  /** One write at a time; its answer, or why it failed, lands in the status. */
  private run(
    request: Observable<WebSearchSettings>,
    done: (settings: WebSearchSettings) => void,
  ): void {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (settings) => {
        this.busy.set(false);
        done(settings);
      },
      error: (err: unknown) => {
        this.busy.set(false);
        this.notice.set({ kind: 'error', text: reasonOf(err) });
      },
    });
  }

  private restOf(plan: number | null, periodEnd: string | null): string {
    const credits =
      plan === null
        ? $localize`:@@webSearch.settings.credits:créditos`
        : $localize`:@@webSearch.settings.creditsOf:de ${this.count(plan)}:plan: créditos`;
    if (periodEnd === null) return credits;
    const date = formatDate(periodEnd, 'dd/MM', this.locale);
    return $localize`:@@webSearch.settings.creditsUntil:${credits}:credits: até ${date}:date:`;
  }

  private count(value: number): string {
    return formatNumber(value, this.locale, '1.0-0');
  }
}

function reasonOf(err: unknown): string {
  const code = toUiErrorCode(err);
  return code === 'VALIDATION_FAILED'
    ? $localize`:@@webSearch.settings.notAKey:Isto não parece uma chave do Firecrawl. Confira e cole de novo.`
    : errorMessage(code);
}
