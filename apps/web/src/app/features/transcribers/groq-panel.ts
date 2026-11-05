import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  LOCALE_ID,
  computed,
  inject,
  linkedSignal,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  GROQ_IDLE_HOURS,
  groqSettingsSchema,
  type GroqMode,
  type GroqSettings,
  type GroqTestFailure,
  type GroqTestResult,
} from '@kb-chat/contracts';
import { GroqApi, groqUrl } from '@core/media/groq-api.js';
import type { Observable } from 'rxjs';

/** What a status line says after an action (UP-01), in words, never by color alone. */
interface Notice {
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

type Section = 'key' | 'mode' | 'cap';

const FAILURES: Record<GroqTestFailure, () => string> = {
  'key-rejected': () =>
    $localize`:@@groq.keyRejected:A chave não foi aceita pelo Groq.`,
  unreachable: () =>
    $localize`:@@groq.unreachable:Não consegui falar com o Groq. Tente de novo em instantes.`,
  'no-key': () =>
    $localize`:@@groq.noKey:Cole a chave do Groq antes de testar.`,
};

const FAILED = (): Notice => ({
  kind: 'error',
  text: $localize`:@@groq.saveFailed:Não consegui salvar. Tente de novo.`,
});

/** The modes as the screen lists them; "Nunca" is the default (BR-1). */
export const GROQ_MODE_OPTIONS: readonly {
  readonly mode: GroqMode;
  readonly label: () => string;
  readonly hint: () => string;
}[] = [
  {
    mode: 'never',
    label: () => $localize`:@@groq.mode.never:Nunca`,
    hint: () =>
      $localize`:@@groq.mode.neverHint:Só o transcritor pareado transcreve. É o padrão.`,
  },
  {
    mode: 'manual',
    label: () => $localize`:@@groq.mode.manual:Só quando eu pedir`,
    hint: () =>
      $localize`:@@groq.mode.manualHint:Aparece "Transcrever com Groq" nos áudios que esperam o transcritor.`,
  },
  {
    mode: 'idle',
    label: () =>
      $localize`:@@groq.mode.idle:Quando o Mac estiver parado há mais de algumas horas`,
    hint: () =>
      $localize`:@@groq.mode.idleHint:Um áudio que espera mais que esse tempo, sem nenhum transcritor visto, vai para o Groq.`,
  },
];

/**
 * "Groq de reserva" (KBC-037; masters): connect the key (sealed, never shown again, BR-3),
 * choose when Groq transcribes (never by default, BR-1), and see the month's media spend
 * against its cap, which only the owner changes (BR-2, FR-5).
 */
@Component({
  selector: 'app-groq-panel',
  templateUrl: './groq-panel.html',
  styleUrls: [
    '../settings/settings-form.css',
    './transcribers-panel.css',
    './groq-panel.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class GroqPanel {
  private readonly api = inject(GroqApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly locale = inject(LOCALE_ID);

  protected readonly loaded = httpResource(() => groqUrl(), {
    parse: (body) => groqSettingsSchema.parse(body),
  });
  /** The last view the API gave: the page's, or a write's answer. */
  protected readonly settings = linkedSignal<GroqSettings | null>(() =>
    this.loaded.hasValue() ? this.loaded.value() : null,
  );
  protected readonly options = GROQ_MODE_OPTIONS;
  protected readonly hoursLimits = GROQ_IDLE_HOURS;
  protected readonly key = signal('');
  protected readonly mode = linkedSignal<GroqMode>(
    () => this.settings()?.mode ?? 'never',
  );
  protected readonly idleHours = linkedSignal<number>(
    () => this.settings()?.idleHours ?? GROQ_IDLE_HOURS.default,
  );
  protected readonly cap = linkedSignal<string>(() =>
    String(this.settings()?.month.capUsd ?? ''),
  );
  protected readonly busy = signal<Section | null>(null);
  protected readonly notices = signal<Partial<Record<Section, Notice>>>({});
  protected readonly spentText = computed(() => {
    const month = this.settings()?.month;
    if (!month) return '';
    return $localize`:@@groq.spent:${this.usd(month.spentUsd)}:spent: de ${this.usd(month.capUsd)}:cap:`;
  });
  protected readonly hoursValid = computed(() => {
    const hours = this.idleHours();
    return (
      Number.isInteger(hours) &&
      hours >= GROQ_IDLE_HOURS.min &&
      hours <= GROQ_IDLE_HOURS.max
    );
  });

  protected editKey(event: Event): void {
    this.key.set((event.target as HTMLInputElement).value);
  }

  protected editHours(event: Event): void {
    this.idleHours.set(Number((event.target as HTMLInputElement).value));
  }

  protected editCap(event: Event): void {
    this.cap.set((event.target as HTMLInputElement).value);
  }

  /** "Testar conexão" (FR-1): a pasted key, or the stored one when the field is empty. */
  protected testKey(event: Event): void {
    event.preventDefault();
    const key = this.key().trim();
    const connected = this.settings()?.connected ?? false;
    if (!key && !connected) return this.say('key', this.failure('no-key'));
    this.run('key', this.api.test(key || undefined), (result) =>
      this.tested(result),
    );
  }

  protected removeKey(): void {
    this.run('key', this.api.removeKey(), (settings) => {
      this.settings.set(settings);
      this.say('key', {
        kind: 'ok',
        text: $localize`:@@groq.removed:Chave removida. O Groq não será usado.`,
      });
    });
  }

  protected chooseMode(mode: GroqMode): void {
    this.mode.set(mode);
  }

  protected saveMode(event: Event): void {
    event.preventDefault();
    if (this.mode() === 'idle' && !this.hoursValid()) return;
    const request = { mode: this.mode(), idleHours: this.idleHours() };
    this.run('mode', this.api.setMode(request), (settings) => {
      this.settings.set(settings);
      this.say('mode', {
        kind: 'ok',
        text: $localize`:@@groq.modeSaved:Modo salvo.`,
      });
    });
  }

  /** The owner's cap (BR-2); the API refuses it to anyone else. */
  protected saveCap(event: Event): void {
    event.preventDefault();
    const capUsd = Number(this.cap().replace(',', '.'));
    if (!Number.isFinite(capUsd) || capUsd < 0 || capUsd > 1_000)
      return this.say('cap', {
        kind: 'error',
        text: $localize`:@@groq.capInvalid:Use um valor de 0 a 1000 dólares.`,
      });
    this.run('cap', this.api.setCap(capUsd), (settings) => {
      this.settings.set(settings);
      this.say('cap', {
        kind: 'ok',
        text: $localize`:@@groq.capSaved:Teto salvo.`,
      });
    });
  }

  protected noticeOf(section: Section): Notice | null {
    return this.notices()[section] ?? null;
  }

  private tested(result: GroqTestResult): void {
    if (!result.ok) return this.say('key', this.failure(result.reason));
    this.settings.set(result.settings);
    this.key.set('');
    this.say('key', {
      kind: 'ok',
      text: $localize`:@@groq.connected:Conectado.`,
    });
  }

  /** One write at a time per section; its answer, or a failure, lands in its status. */
  private run<T>(
    section: Section,
    request: Observable<T>,
    done: (value: T) => void,
  ): void {
    if (this.busy()) return;
    this.busy.set(section);
    this.say(section, null);
    request.pipe(takeUntilDestroyed(this.destroyRef)).subscribe({
      next: (value) => {
        this.busy.set(null);
        done(value);
      },
      error: () => {
        this.busy.set(null);
        this.say(section, FAILED());
      },
    });
  }

  private failure(reason: GroqTestFailure): Notice {
    return { kind: 'error', text: FAILURES[reason]() };
  }

  private say(section: Section, notice: Notice | null): void {
    this.notices.update((all) => ({ ...all, [section]: notice ?? undefined }));
  }

  private usd(value: number): string {
    return new Intl.NumberFormat(this.locale, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }
}
