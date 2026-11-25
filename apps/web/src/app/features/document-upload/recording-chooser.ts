import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import type { RecordingEntry } from '@kb-chat/contracts';
import { UiButton } from '@ui/index.js';

const two = (n: number): string => String(n).padStart(2, '0');

/** "1:02:03", "4:05"; nothing when the list does not say. */
export function durationText(seconds: number | null): string {
  if (seconds === null) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = two(Math.floor(seconds % 60));
  return hours > 0 ? `${hours}:${two(minutes)}:${rest}` : `${minutes}:${rest}`;
}

let nextId = 0;

/**
 * What a channel or playlist holds (KBC-186 R7): none is taken before the person says which.
 * They come unmarked, for a channel has hundreds; "Selecionar todos" is one press.
 */
@Component({
  selector: 'app-recording-chooser',
  imports: [UiButton],
  template: `
    <fieldset [disabled]="disabled()">
      <legend i18n="@@chooser.legend">Quais entram no acervo</legend>
      <div class="all">
        <label class="line">
          <input
            type="checkbox"
            [checked]="allChosen()"
            [indeterminate]="someChosen()"
            (change)="toggleAll()"
          />
          <span i18n="@@chooser.all"
            >Selecionar todos ({{ entries().length }})</span
          >
        </label>
        <p class="sum" role="status">
          <span i18n="@@chooser.sum">{chosen().size, plural,
            =0 {Nenhum escolhido}
            =1 {1 escolhido}
            other {{{ chosen().size }} escolhidos}
          }</span>
          @if (total(); as text) {
            · {{ text }}
          }
        </p>
      </div>
      <ul>
        @for (entry of entries(); track entry.url) {
          <li>
            <label class="line" [for]="idOf($index)">
              <input
                type="checkbox"
                [id]="idOf($index)"
                [checked]="chosen().has(entry.url)"
                (change)="toggle(entry.url)"
              />
              <span class="title">{{ entry.title }}</span>
              <span class="time">{{ time(entry) }}</span>
            </label>
          </li>
        }
      </ul>
      <button
        uiButton="primary"
        size="sm"
        type="button"
        class="include"
        [disabled]="chosen().size === 0"
        (click)="pick()"
      >
        <span i18n="@@chooser.include">{chosen().size, plural,
          =0 {Incluir}
          =1 {Incluir 1 gravação}
          other {Incluir {{ chosen().size }} gravações}
        }</span>
      </button>
    </fieldset>
  `,
  styles: `
    fieldset {
      display: grid;
      gap: var(--space-3);
      min-width: 0;
      margin: 0;
      padding: var(--space-3) 0 0;
      border: none;
    }

    legend {
      padding: 0;
      font-size: var(--text-sm);
      font-weight: 700;
    }

    .all {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-2) var(--space-4);
      align-items: center;
      justify-content: space-between;
    }

    .sum {
      margin: 0;
      color: var(--color-text-muted);
      font-size: var(--text-meta);
    }

    ul {
      max-height: 20rem;
      margin: 0;
      padding: 0;
      overflow-y: auto;
      list-style: none;
    }

    .line {
      display: flex;
      gap: var(--space-3);
      align-items: center;
      min-height: 2.75rem;
      font-size: var(--text-sm);
      cursor: pointer;
    }

    input {
      flex: none;
      width: 1.25rem;
      height: 1.25rem;
      accent-color: var(--color-accent);
    }

    .title {
      flex: 1;
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .time {
      flex: none;
      color: var(--color-text-muted);
      font-size: var(--text-meta);
      font-variant-numeric: tabular-nums;
    }

    .include {
      justify-self: start;
      min-height: 2.75rem;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class RecordingChooser {
  readonly entries = input.required<readonly RecordingEntry[]>();
  readonly disabled = input(false);
  readonly picked = output<readonly string[]>();

  private readonly id = `recording-chooser-${nextId++}`;
  /** A new reading of the list keeps what was chosen and is still there. */
  protected readonly chosen = linkedSignal<
    readonly RecordingEntry[],
    ReadonlySet<string>
  >({
    source: this.entries,
    computation: (entries, before) =>
      new Set(
        entries
          .map((one) => one.url)
          .filter((url) => before?.value.has(url) === true),
      ),
  });
  protected readonly allChosen = computed(
    () => this.chosen().size === this.entries().length,
  );
  protected readonly someChosen = computed(
    () => this.chosen().size > 0 && !this.allChosen(),
  );
  /** How long the chosen ones play, when the list says it of any of them. */
  protected readonly total = computed(() => {
    const seconds = this.entries()
      .filter((one) => this.chosen().has(one.url))
      .reduce((sum, one) => sum + (one.durationS ?? 0), 0);
    return seconds > 0 ? durationText(seconds) : '';
  });

  protected idOf(index: number): string {
    return `${this.id}-${index}`;
  }

  protected time(entry: RecordingEntry): string {
    return durationText(entry.durationS);
  }

  protected toggle(url: string): void {
    this.chosen.update((before) => {
      const next = new Set(before);
      if (!next.delete(url)) next.add(url);
      return next;
    });
  }

  protected pick(): void {
    this.picked.emit([...this.chosen()]);
  }

  protected toggleAll(): void {
    const all = this.allChosen();
    this.chosen.set(new Set(all ? [] : this.entries().map((one) => one.url)));
  }
}
