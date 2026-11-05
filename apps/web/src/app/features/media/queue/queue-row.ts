import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ProcessingQueueItem, RetryStage } from '@kb-chat/contracts';
import { mediaPagePath } from '@core/media/media-api.js';
import { editPagePath } from '@core/media/media-edit-api.js';
import { preparationPagePath } from '@core/media/preparation-api.js';
import {
  queueNextText,
  queuePositionText,
  queueProgressText,
  queueStateText,
} from './queue-labels.js';

/** What pressing a row's button asks. */
export type QueueMove =
  | { readonly kind: 'retry'; readonly stage: RetryStage }
  | { readonly kind: 'advance' };

/**
 * One audio of the queue (T30, KBC-090): where it is in words, its bar, its place and what
 * comes after. The paid stage's "Tentar de novo" is a link: the value is seen on its page
 * before the press (KBC-072 BR-4). A row with no action has only its title to follow.
 */
@Component({
  selector: 'app-queue-row',
  imports: [RouterLink],
  templateUrl: './queue-row.html',
  styleUrls: ['../preparation/preparation-buttons.css', './queue-row.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'listitem',
    '[class.failed]': "item().state === 'failed'",
    '[class.current]': "item().phase === 'running'",
  },
})
export class QueueRow {
  readonly item = input.required<ProcessingQueueItem>();
  /** The collection's name. */
  readonly topicTitle = input.required<string>();
  /** The person opens plans: otherwise the title leads to the audio. */
  readonly canEdit = input(false);
  readonly busy = input(false);
  readonly moved = output<QueueMove>();
  private readonly titleLink = viewChild<ElementRef<HTMLElement>>('title');

  protected readonly link = computed(() => {
    const { mediaId, step } = this.item();
    if (step === null || !this.canEdit()) return mediaPagePath(mediaId);
    return step === 3 ? editPagePath(mediaId) : preparationPagePath(mediaId);
  });
  protected readonly stateText = computed(() => queueStateText(this.item()));
  protected readonly positionText = computed(() =>
    queuePositionText(this.item()),
  );
  protected readonly nextText = computed(() => queueNextText(this.item()));
  protected readonly progressText = computed(() =>
    queueProgressText(this.item()),
  );
  protected readonly showBar = computed(() => {
    const { state, percent } = this.item();
    return state === 'running' && percent !== null;
  });
  /** Free stages retry here; the paid one needs its value in sight first. */
  protected readonly retryStage = computed(() => {
    const { retryStage } = this.item();
    return retryStage === 'tracks' ? null : retryStage;
  });

  /** After a press the button may be gone: the focus stays on the row. */
  focusTitle(): void {
    this.titleLink()?.nativeElement.focus();
  }

  protected retry(stage: RetryStage): void {
    this.moved.emit({ kind: 'retry', stage });
  }

  protected advance(): void {
    this.moved.emit({ kind: 'advance' });
  }
}
