import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  linkedSignal,
  signal,
} from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  DEFAULT_DAILY_RESEARCHES,
  MAX_DAILY_RESEARCHES,
  OPENROUTER_FREE_ROUTER,
  type AppAi,
  type HouseAiUpdate,
  type HouseAiView,
} from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { HouseAiApi } from '@core/api/house-ai-api.js';
import { GO_TO_URL } from '@core/routing/go-to-url.js';
import { parseDaily } from './number-fields.js';
import { TEST_COPY } from '@features/settings/provider-copy.js';
import type { Observable } from 'rxjs';

type Status = { readonly kind: 'ok' | 'error'; readonly text: string } | null;

/** How "IA da aplicação" opens after OpenRouter sends the master back. */
export type ConnectOutcome = 'connected' | 'error' | null;

const SAVED = () => $localize`:@@house.saved:Salvo.`;
const SAVE_FAILED = () =>
  $localize`:@@house.saveFailed:Não consegui salvar. Tente de novo.`;

/**
 * "IA da aplicação" (KBC-022, screens.md T12, masters): the house OpenRouter account (OAuth
 * or a pasted key), its free models, the paid fallback, the default AI and quota.
 */
@Component({
  selector: 'app-house-ai-panel',
  imports: [DatePipe],
  templateUrl: './house-ai-panel.html',
  styleUrls: ['../settings/settings-form.css', './house-ai-panel.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HouseAiPanel {
  private readonly api = inject(HouseAiApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly goTo = inject(GO_TO_URL);
  /** The outcome of an OpenRouter round trip, announced once. */
  readonly outcome = input<ConnectOutcome>(null);

  protected readonly house = rxResource({ stream: () => this.api.view() });
  protected readonly freeModels = rxResource({
    stream: () => this.api.freeModels(),
  });
  protected readonly view = computed(() =>
    this.house.hasValue() ? this.house.value() : null,
  );
  protected readonly status = linkedSignal<Status>(() => {
    const outcome = this.outcome();
    if (outcome === 'connected')
      return {
        kind: 'ok',
        text: $localize`:@@house.connected:Conta conectada.`,
      };
    if (outcome === 'error')
      return {
        kind: 'error',
        text: $localize`:@@house.connectFailed:Não consegui conectar. Tente de novo.`,
      };
    return null;
  });
  protected readonly busy = signal(false);
  protected readonly pasting = signal(false);
  protected readonly confirmingDisconnect = signal(false);
  protected readonly keyDraft = signal('');
  protected readonly managementDraft = signal('');
  protected readonly paidDraft = linkedSignal(
    () => this.view()?.paidModel ?? '',
  );
  protected readonly auto = computed(() => this.view()?.freeModels === null);
  protected readonly modelItems = computed(() => {
    const chosen = this.view()?.freeModels ?? [];
    const items = this.freeModels.hasValue()
      ? this.freeModels.value().items
      : [];
    return items.map((model) => ({
      ...model,
      checked: chosen.includes(model.id),
    }));
  });
  protected readonly listInfo = computed(() =>
    this.freeModels.hasValue() ? this.freeModels.value() : null,
  );
  protected readonly lowLimit = computed(() => {
    const usage = this.view()?.freeUsage;
    return usage !== null && usage !== undefined && usage.limit < 1000;
  });
  protected readonly defaultDaily = computed(
    () => this.view()?.defaultDailyResearches ?? DEFAULT_DAILY_RESEARCHES,
  );
  protected readonly router = OPENROUTER_FREE_ROUTER;
  protected readonly maxDaily = MAX_DAILY_RESEARCHES;
  /** Why the typed default was not saved (MA-23). */
  protected readonly dailyError = signal<string | null>(null);
  /** The order the house tries the models in, for the hint. */
  protected readonly chainText = computed(
    () => this.view()?.chain.join(' → ') ?? '',
  );
  /** Paid models with tool calling: the suggestions of the paid fallback field. */
  protected readonly paidOptions = computed(() => this.listInfo()?.paid ?? []);

  /** "Conectar OpenRouter": the server makes the PKCE pair; the browser goes to OpenRouter. */
  protected connect(): void {
    this.busy.set(true);
    this.api
      .connect('house')
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (url) => this.goTo(url),
        error: (err: unknown) => this.fail(err),
      });
  }

  protected saveKey(): void {
    const key = this.keyDraft().trim();
    if (!key) return;
    this.save({ key }, () => {
      this.keyDraft.set('');
      this.pasting.set(false);
    });
  }

  protected test(): void {
    this.run(this.api.test(), (result) =>
      this.status.set(
        result.ok
          ? {
              kind: 'ok',
              text: $localize`:@@house.testOk:Conexão funcionando.`,
            }
          : {
              kind: 'error',
              text: TEST_COPY[result.code ?? 'PROVIDER_UNAVAILABLE'](),
            },
      ),
    );
  }

  protected disconnect(): void {
    this.confirmingDisconnect.set(false);
    this.run(this.api.disconnect(), () => {
      this.house.reload();
      this.status.set({
        kind: 'ok',
        text: $localize`:@@house.disconnected:Conta desconectada.`,
      });
    });
  }

  protected setAuto(on: boolean): void {
    const current = this.modelItems()
      .filter((m) => m.checked)
      .map((m) => m.id);
    const fallback =
      this.listInfo()
        ?.items.slice(0, 3)
        .map((m) => m.id) ?? [];
    this.save({ freeModels: on ? null : current.length ? current : fallback });
  }

  protected toggleModel(id: string, on: boolean): void {
    const chosen = this.view()?.freeModels ?? [];
    const next = on ? [...chosen, id] : chosen.filter((m) => m !== id);
    this.save({ freeModels: next });
  }

  protected setRouter(on: boolean): void {
    this.save({ includeRouter: on });
  }

  protected savePaid(): void {
    const model = this.paidDraft().trim();
    this.save({ paidModel: model || null });
  }

  protected setDefaultAppAi(appAi: AppAi): void {
    this.save({ defaultAppAi: appAi });
  }

  protected setDefaultDaily(value: string): void {
    const parsed = parseDaily(value, false);
    this.dailyError.set(parsed.ok ? null : parsed.error);
    if (parsed.ok && parsed.value !== null)
      this.save({ defaultDailyResearches: parsed.value });
  }

  protected saveManagement(remove = false): void {
    const key = this.managementDraft().trim();
    if (!remove && !key) return;
    this.save({ managementKey: remove ? null : key }, () =>
      this.managementDraft.set(''),
    );
  }

  private save(update: HouseAiUpdate, then?: () => void): void {
    this.run(this.api.save(update), (view: HouseAiView) => {
      this.house.set(view);
      this.status.set({ kind: 'ok', text: SAVED() });
      then?.();
    });
  }

  private run<T>(call: Observable<T>, done: (value: T) => void): void {
    this.busy.set(true);
    call.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => {
        this.busy.set(false);
        done(value);
      },
      error: (err: unknown) => this.fail(err),
    });
  }

  private fail(err: unknown): void {
    this.busy.set(false);
    const code = toUiErrorCode(err);
    const text = code === 'INTERNAL' ? SAVE_FAILED() : errorMessage(code);
    this.status.set({ kind: 'error', text });
  }
}
