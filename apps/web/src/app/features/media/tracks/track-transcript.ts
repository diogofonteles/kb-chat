import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  input,
  output,
  viewChild,
} from '@angular/core';
import type { TranscriptSegment } from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';

/** A span of the recording chosen in the text. */
export interface TextSpan {
  readonly startMs: number;
  readonly endMs: number;
}

/**
 * The transcript under the bar (T20, third in the hierarchy): a time goes to that point, and
 * selecting text offers a new track there (the scope's "selecionar na transcrição"). The
 * button before each passage is the way there for whoever does not use a mouse.
 */
@Component({
  selector: 'app-track-transcript',
  template: `
    <ol
      #list
      class="segments"
      (mouseup)="readSelection()"
      (keyup)="readSelection()"
    >
      @for (row of rows(); track row.startMs) {
        <li class="segment" [class.inside]="row.inside">
          <button type="button" class="time" (click)="place.emit(row.startMs)">
            {{ row.clock }}
          </button>
          <span class="text" [attr.data-segment]="row.index">{{
            row.text
          }}</span>
        </li>
      }
    </ol>
  `,
  styles: `
    :host {
      display: block;
      min-width: 0;
    }
    .segments {
      display: grid;
      gap: var(--space-1);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .segment {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: var(--space-2);
      padding-inline: var(--space-1);
      border-left: 3px solid transparent;
      content-visibility: auto;
      contain-intrinsic-size: auto 3rem;
    }
    .segment.inside {
      border-left-color: var(--color-accent);
    }
    .time {
      min-width: 44px;
      min-height: 32px;
      padding: 0 var(--space-1);
      border: 0;
      background: none;
      color: var(--color-text-muted);
      font: inherit;
      font-size: var(--text-sm);
      font-variant-numeric: tabular-nums;
      cursor: pointer;
    }
    .text {
      font-family: var(--font-reading);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackTranscript {
  readonly segments = input.required<readonly TranscriptSegment[]>();
  /** The selected track's span: its passages are marked at the side. */
  readonly span = input<TextSpan | null>(null);
  readonly place = output<number>();
  /** What the person selected; null when nothing is. */
  readonly selection = output<TextSpan | null>();

  private readonly list = viewChild.required<ElementRef<HTMLElement>>('list');

  protected readonly rows = computed(() => {
    const span = this.span();
    return this.segments().map((segment, index) => ({
      ...segment,
      index,
      clock: formatClock(segment.startMs),
      inside:
        span !== null &&
        segment.startMs < span.endMs &&
        segment.endMs > span.startMs,
    }));
  });

  protected readSelection(): void {
    const selection = this.list().nativeElement.ownerDocument.getSelection();
    if (!selection || selection.isCollapsed) {
      this.selection.emit(null);
      return;
    }
    const first = this.segmentOf(selection.anchorNode);
    const last = this.segmentOf(selection.focusNode);
    if (first === null || last === null) {
      this.selection.emit(null);
      return;
    }
    const from = this.segments()[Math.min(first, last)];
    const to = this.segments()[Math.max(first, last)];
    this.selection.emit(
      from && to ? { startMs: from.startMs, endMs: to.endMs } : null,
    );
  }

  private segmentOf(node: Node | null): number | null {
    const element = node instanceof Element ? node : node?.parentElement;
    const index = element
      ?.closest('[data-segment]')
      ?.getAttribute('data-segment');
    return index == null ? null : Number(index);
  }
}
