import { formatNumber } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  LOCALE_ID,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import {
  DOCUMENT_BATCH_MAX_USD,
  type DocumentUpload,
  type UploadedDocumentRef,
} from '@kb-chat/contracts';
import { UiButton, UiIcon, UiIconButton, UiPill } from '@ui/index.js';
import { statusText, stepsOf } from './document-progress.js';
import { ListEntries } from './list-entries.js';
import { FAILURE_TEXTS, hintOf, isWorking, labelOf } from './upload-labels.js';

const ICONS = {
  file: 'file',
  url: 'link',
  recording: 'music',
  list: 'list',
} as const;

/**
 * One sent item (KBC-149, KBC-184): its name, its state in a word, its steps and which one it
 * is in, what is known of it now (its place in line, how long), why it failed or waits, and
 * what can be done about it.
 */
@Component({
  selector: 'app-document-upload-row',
  imports: [ListEntries, UiButton, UiIcon, UiIconButton, UiPill],
  template: `
    <span class="art" aria-hidden="true">
      <ui-icon [name]="icon()" [size]="20" />
    </span>
    <div class="text">
      <p class="name">{{ upload().name }}</p>
      @if (topicTitle(); as title) {
        <p class="meta">{{ title }}</p>
      }
      @if (failure(); as why) {
        <p class="why">{{ why }}</p>
      } @else if (held(); as why) {
        <p class="why">{{ why }}</p>
      }
      @if (status(); as text) {
        <p class="now">{{ text }}</p>
      }
      @if (hint(); as text) {
        <p class="hint">{{ text }}</p>
      }
      @if (upload().detail; as detail) {
        <p class="detail">{{ detail }}</p>
      }
    </div>
    <ui-pill [tone]="label().tone">{{ label().text() }}</ui-pill>
    <div class="actions">
      @if (ready(); as doc) {
        <button
          uiButton="outline"
          size="sm"
          type="button"
          (click)="opened.emit(doc)"
        >
          <span i18n="@@docUploads.open">Abrir</span>
        </button>
      }
      @if (canRaise()) {
        <button
          uiButton="outline"
          size="sm"
          type="button"
          [disabled]="busy()"
          (click)="raised.emit()"
        >
          <span i18n="@@docUploads.raise">Aumentar o teto em US$ 0,50</span>
        </button>
      }
      @if (upload().retriable) {
        <button
          uiButton="outline"
          size="sm"
          type="button"
          [disabled]="busy()"
          (click)="retried.emit()"
        >
          <span i18n="@@docUploads.retry">Tentar de novo</span>
        </button>
      }
      @if (canRemove()) {
        <button
          uiIconButton
          class="remove"
          type="button"
          [size]="44"
          [attr.aria-label]="removeLabel()"
          [disabled]="busy()"
          (click)="removed.emit()"
        >
          <ui-icon name="close" [size]="18" />
        </button>
      }
    </div>
    @if (steps(); as all) {
      <!-- Drawn for the eye; the state's word, and the line under it, say it in text. -->
      <div class="steps" aria-hidden="true">
        @for (word of all.words; track word) {
          <span
            class="step"
            [class.done]="$index < all.at"
            [class.now]="$index === all.at"
            [attr.data-word]="word"
          ></span>
        }
      </div>
      @if (stepText(); as text) {
        <span class="visually-hidden">{{ text }}</span>
      }
    }
    @if (upload().entryCount > 0) {
      <app-list-entries
        class="chooser"
        [listId]="upload().id"
        [disabled]="busy()"
        (picked)="chosen.emit($event)"
      />
    }
  `,
  styleUrl: './document-upload-row.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DocumentUploadRow {
  private readonly locale = inject(LOCALE_ID);

  readonly upload = input.required<DocumentUpload>();
  /** Its collection's name, when the list has more than one. */
  readonly topicTitle = input('');
  /** A press is on some item. */
  readonly busy = input(false);
  /** When it was read: "há 1 min" is measured to it. */
  readonly at = input.required<number>();

  readonly opened = output<UploadedDocumentRef>();
  readonly raised = output();
  readonly retried = output();
  readonly removed = output();
  readonly chosen = output<readonly string[]>();

  protected readonly icon = computed(() => ICONS[this.upload().kind]);
  protected readonly label = computed(() => labelOf(this.upload()));
  protected readonly steps = computed(() => stepsOf(this.upload()));
  protected readonly stepText = computed(() => {
    const steps = this.steps();
    if (!steps || steps.at >= steps.words.length) return '';
    return $localize`:@@docProgress.stepOf:Etapa ${steps.at + 1}:at: de ${steps.words.length}:total:`;
  });
  protected readonly hint = computed(() => hintOf(this.upload()));
  protected readonly failure = computed(() => {
    const { failure } = this.upload();
    return failure ? FAILURE_TEXTS[failure]() : '';
  });
  protected readonly status = computed(() =>
    statusText(this.upload(), this.at()),
  );
  protected readonly ready = computed(() => {
    const { state, document } = this.upload();
    return state === 'ready' ? document : null;
  });
  protected readonly canRaise = computed(() => {
    const { heldBy, batch } = this.upload();
    return (
      heldBy === 'batch-cap' &&
      batch !== null &&
      batch.capUsd < DOCUMENT_BATCH_MAX_USD
    );
  });
  protected readonly canRemove = computed(
    () => !isWorking(this.upload().state),
  );
  protected readonly removeLabel = computed(
    () =>
      $localize`:@@docUploads.remove:Tirar ${this.upload().name}:name: da lista`,
  );
  protected readonly held = computed(() => {
    const { heldBy, batch } = this.upload();
    if (heldBy === 'month-cap')
      return $localize`:@@docUploads.heldMonth:O teto de gasto do mês foi atingido. Continua quando o dono aumentar ou o mês virar.`;
    if (heldBy !== 'batch-cap' || !batch) return '';
    const cap = formatNumber(batch.capUsd, this.locale, '1.2-2');
    return $localize`:@@docUploads.heldBatch:O teto desta inclusão (US$ ${cap}:cap:) foi atingido. Aumente para continuar.`;
  });
}
