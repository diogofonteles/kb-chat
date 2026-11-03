import { DatePipe } from '@angular/common';
import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  LOCALE_ID,
  afterNextRender,
  afterRenderEffect,
  computed,
  inject,
  linkedSignal,
  signal,
  viewChild,
  viewChildren,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { mediaListSchema, type MediaItem } from '@kb-chat/contracts';
import { formatClock, formatDuration, resumeFrom } from '@kb-chat/player-core';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import { MediaApi, mediaListUrl } from '@core/media/media-api.js';
import { AuthorshipBadge } from '@features/authorship/authorship-badge.js';
import { ChatStore } from '@features/chat/chat-store.js';
import {
  EMPTY,
  distinctUntilChanged,
  filter,
  interval,
  pairwise,
  switchMap,
} from 'rxjs';
import {
  ANY_AUTHOR,
  authorFilterOptions,
  matchesAuthor,
} from './media-authors.js';
import {
  pollEveryOf,
  isLowConfidence,
  lowNoticeOf,
  statusTextOf,
  transcriptionTextOf,
} from './media-labels.js';
import { matchesTitle, newlyReady, summaryOf } from './media-summary.js';
import { MEDIA_POLL_MS } from './media-polling.js';
import { RowMenu } from './row-menu.js';
import { UploadPanel } from './upload-panel.js';

/** The title filter appears from this many items on (T14). */
export const FILTER_FROM = 11;

/**
 * "Mídia" (screens.md T14, KBC-034 FR-6): the selected collection's audio, its status in
 * words, the upload for who may send, and the masters' "Tentar de novo" and "Remover".
 */
@Component({
  selector: 'app-media-list-page',
  imports: [RouterLink, DatePipe, AuthorshipBadge, UploadPanel, RowMenu],
  templateUrl: './media-list-page.html',
  styleUrl: './media-list-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(focusin)': 'keepInView($event)' },
})
export class MediaListPage {
  private readonly chat = inject(ChatStore);
  private readonly session = inject(SessionStore);
  private readonly api = inject(MediaApi);
  private readonly injector = inject(Injector);
  private readonly pollMs = inject(MEDIA_POLL_MS);
  private readonly locale = inject(LOCALE_ID);
  private readonly removeDialog =
    viewChild<ElementRef<HTMLDialogElement>>('removeDialog');
  private readonly rows = viewChildren<ElementRef<HTMLElement>>('row');
  private readonly heading =
    viewChild.required<ElementRef<HTMLElement>>('heading');
  private readonly destroyRef = inject(DestroyRef);
  /** The item to focus once it is on screen (after an upload). */
  private pendingFocus: string | null = null;

  protected readonly topic = this.chat.topic;
  protected readonly topics = this.chat.topicList;
  protected readonly list = httpResource(
    () => {
      const slug = this.chat.topicSlug();
      return slug ? mediaListUrl(slug) : undefined;
    },
    { parse: (body) => mediaListSchema.parse(body) },
  );
  protected readonly items = computed(() =>
    this.list.hasValue() ? this.list.value().items : [],
  );
  protected readonly query = signal('');
  /** "Autoria" (KBC-049 FR-4): every author by default, reset on a switch. */
  protected readonly author = linkedSignal({
    source: this.chat.topicSlug,
    computation: () => ANY_AUTHOR,
  });
  protected readonly authorOptions = computed(() =>
    authorFilterOptions(this.items()),
  );
  /** Shown when the list has two or more authorships to tell apart. */
  protected readonly showAuthorFilter = computed(
    () => this.authorOptions().length >= 2,
  );
  protected readonly visible = computed(() =>
    this.items().filter(
      (item) =>
        matchesTitle(item, this.query()) && matchesAuthor(item, this.author()),
    ),
  );
  protected readonly showFilter = computed(
    () => this.items().length >= FILTER_FROM,
  );
  protected readonly summary = computed(() => summaryOf(this.items()));
  protected readonly canUpload = computed(() =>
    this.session.can('media-upload'),
  );
  protected readonly isMaster = this.session.isMaster;
  protected readonly loadError = computed(() => {
    const err = this.list.error();
    return err ? errorMessage(toUiErrorCode(err)) : '';
  });
  protected readonly uploading = signal(false);
  protected readonly removing = signal<MediaItem | null>(null);
  protected readonly actionError = signal('');
  protected readonly announcement = signal('');
  /** Where the last upload went, when it was another collection; cleared on a switch. */
  protected readonly sentElsewhere = linkedSignal({
    source: this.chat.topicSlug,
    computation: () => '',
  });

  constructor() {
    this.pollWhileInFlight();
    this.announceReady();
    afterRenderEffect(() => this.focusPending(this.rows()));
  }

  /**
   * The page scrolls in its own row (above the mini-player): the element that takes the
   * focus is brought fully into view, in every browser (WCAG 2.4.11, KBC-041 FR-11).
   */
  protected keepInView(event: FocusEvent): void {
    if (event.target instanceof HTMLElement)
      event.target.scrollIntoView?.({ block: 'nearest' });
  }

  /** Where its transcription is (KBC-036 FR-1), next to the status. */
  protected transcriptionOf(item: MediaItem): string {
    return transcriptionTextOf(item, this.locale);
  }

  protected isLow(item: MediaItem): boolean {
    return isLowConfidence(item);
  }

  protected lowNoticeOf(item: MediaItem): string {
    return lowNoticeOf(item);
  }

  protected statusOf(item: MediaItem): string {
    return statusTextOf(item);
  }

  protected menuLabelOf(item: MediaItem): string {
    return $localize`:@@media.moreActions:Mais ações para ${item.title}:title:`;
  }

  /** "Continuar de 23:10" for a media with a saved position, not yet heard (T14). */
  protected resumeTextOf(item: MediaItem): string {
    const at =
      item.status === 'ready'
        ? resumeFrom(item.positionMs, item.durationMs)
        : null;
    return at === null
      ? ''
      : $localize`:@@media.resumeFrom:Continuar de ${formatClock(at)}:time:`;
  }

  /** How much of it was heard, for the thin bar under the row. */
  protected percentOf(item: MediaItem): number {
    return item.durationMs ? (item.positionMs / item.durationMs) * 100 : 0;
  }

  protected durationOf(item: MediaItem): string {
    return item.durationMs === null ? '' : formatDuration(item.durationMs);
  }

  protected filterBy(event: Event): void {
    if (event.target instanceof HTMLInputElement)
      this.query.set(event.target.value);
  }

  protected filterByAuthor(event: Event): void {
    if (event.target instanceof HTMLSelectElement)
      this.author.set(event.target.value);
  }

  protected clearFilter(): void {
    this.query.set('');
    this.author.set(ANY_AUTHOR);
  }

  protected openUpload(): void {
    this.sentElsewhere.set('');
    this.uploading.set(true);
  }

  protected uploadClosed(): void {
    this.uploading.set(false);
  }

  /**
   * The new item lands on top, "Na fila", with the focus on it (UP-01); one sent to another
   * collection is not on this list, so the page says where it went (UP-01, MA-25).
   */
  protected uploaded(item: MediaItem): void {
    if (item.topic !== this.chat.topicSlug()) {
      const title =
        this.topics().find((topic) => topic.slug === item.topic)?.title ??
        item.topic;
      this.sentElsewhere.set(
        $localize`:@@media.sentElsewhere:${item.title}:title: foi enviado para o acervo ${title}:topic:.`,
      );
      return;
    }
    this.pendingFocus = item.id;
    this.list.reload();
  }

  protected retry(item: MediaItem): void {
    this.actionError.set('');
    this.api
      .retry(item.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.list.reload(),
        error: (err: unknown) =>
          this.actionError.set(errorMessage(toUiErrorCode(err))),
      });
  }

  protected askRemove(item: MediaItem): void {
    this.removing.set(item);
    afterNextRender(() => this.removeDialog()?.nativeElement.showModal(), {
      injector: this.injector,
    });
  }

  protected confirmRemove(): void {
    const item = this.removing();
    this.removeDialog()?.nativeElement.close();
    if (!item) return;
    this.api
      .remove(item.id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.removed(item),
        error: (err: unknown) =>
          this.actionError.set(errorMessage(toUiErrorCode(err))),
      });
  }

  /** The row is gone: say so and keep the focus on the page, not on <body> (NG-30). */
  private removed(item: MediaItem): void {
    this.list.reload();
    this.announcement.set(
      $localize`:@@media.removedAnnouncement:${item.title}:title: foi removido.`,
    );
    this.heading().nativeElement.focus();
  }

  protected cancelRemove(): void {
    this.removeDialog()?.nativeElement.close();
  }

  protected removeClosed(): void {
    this.removing.set(null);
  }

  protected reload(): void {
    this.list.reload();
  }

  private pollWhileInFlight(): void {
    const every = computed(() => pollEveryOf(this.items(), this.pollMs));
    toObservable(every)
      .pipe(
        distinctUntilChanged(),
        switchMap((ms) => (ms === null ? EMPTY : interval(ms))),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.list.reload());
  }

  /** "Palestra de 1998 está pronta." once, in the live region (T14). */
  private announceReady(): void {
    toObservable(this.items)
      .pipe(
        pairwise(),
        filter(([before, after]) => newlyReady(before, after).length > 0),
        takeUntilDestroyed(),
      )
      .subscribe(([before, after]) => {
        const titles = newlyReady(before, after).map((item) => item.title);
        this.announcement.set(
          titles.length === 1
            ? $localize`:@@media.readyOne:${titles[0]}:title: está pronta.`
            : $localize`:@@media.readyMany:${titles.join(', ')}:titles: estão prontas.`,
        );
      });
  }

  private focusPending(rows: readonly ElementRef<HTMLElement>[]): void {
    const id = this.pendingFocus;
    if (!id) return;
    const row = rows.find((ref) => ref.nativeElement.dataset['mediaId'] === id);
    if (!row) return;
    this.pendingFocus = null;
    row.nativeElement.focus();
  }
}
