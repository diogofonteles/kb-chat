import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { trackEditViewSchema, type MediaItem } from '@kb-chat/contracts';
import { errorMessage, toUiErrorCode } from '@core/api/api-error.js';
import { SessionStore } from '@core/auth/session-store.js';
import { editPagePath } from '@core/media/media-edit-api.js';
import {
  TrackRevisionsApi,
  trackBoundsPath,
  trackEditUrl,
} from '@core/media/track-revisions-api.js';
import { EMPTY, distinctUntilChanged, interval, map, switchMap } from 'rxjs';
import { MEDIA_POLL_MS } from '../media-polling.js';
import { TrackDeleteDialog } from './track-delete-dialog.js';
import { TrackEditDialog } from './track-edit-dialog.js';
import { TrackHistory } from './track-history.js';
import { restoreFailureText } from './track-restore-failure.js';

type Dialog = 'edit' | 'delete';

/** `?acao=` of the library's ⋯ menu: the page opens on that dialog once, then forgets it. */
const dialogOf = (action: string | null): Dialog | null => {
  if (action === 'editar') return 'edit';
  if (action === 'apagar') return 'delete';
  return null;
};

/**
 * What who edits does on a track's page (KBC-073, screen spec): "Editar", "Ajustar início e
 * fim", "Apagar faixa", "Histórico", and "Restaurar faixa" once deleted. None of it exists
 * without `media-edit` (AC-14).
 */
@Component({
  selector: 'app-track-actions',
  imports: [RouterLink, TrackEditDialog, TrackDeleteDialog, TrackHistory],
  templateUrl: './track-actions.html',
  styleUrls: ['./track-edit.css', './track-actions.css'],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TrackActions {
  private readonly api = inject(TrackRevisionsApi);
  private readonly session = inject(SessionStore);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly pollMs = inject(MEDIA_POLL_MS);
  private readonly editButton =
    viewChild<ElementRef<HTMLButtonElement>>('editButton');

  readonly media = input.required<MediaItem>();
  /** The item changed: the page reads it again; `null` says to read it from the server. */
  readonly changed = output<MediaItem | null>();

  protected readonly canClassify = computed(() =>
    this.session.can('media-classify'),
  );
  protected readonly canSuggest = computed(() =>
    this.session.can('media-edit-ai'),
  );
  protected readonly view = httpResource(
    () => (this.media().archived ? undefined : trackEditUrl(this.media().id)),
    { parse: (body) => trackEditViewSchema.parse(body) },
  );
  protected readonly current = computed(() =>
    this.view.hasValue() ? this.view.value() : null,
  );
  private readonly cut = computed(() => this.current()?.cut ?? 'none');
  protected readonly cutting = computed(() => this.cut() === 'running');
  protected readonly cutFailed = computed(() => this.cut() === 'failed');
  protected readonly cutDone = signal(false);
  protected readonly open = signal<Dialog | null>(null);
  protected readonly historyOpen = signal(false);
  protected readonly failure = signal('');
  protected readonly restoring = signal(false);
  protected readonly boundsLink = computed(() =>
    trackBoundsPath(this.media().id),
  );
  protected readonly editLink = computed(() =>
    editPagePath(this.current()?.recordingId ?? ''),
  );
  private readonly asked = toSignal(
    this.route.queryParamMap.pipe(map((params) => params.get('acao'))),
    { initialValue: null },
  );

  constructor() {
    this.openAsked();
    this.followCut();
  }

  private openAsked(): void {
    effect(() => {
      const dialog = dialogOf(this.asked());
      const track = this.current();
      if (!dialog || !track || track.locked) return;
      untracked(() => {
        this.open.set(dialog);
        void this.router.navigate([], {
          relativeTo: this.route,
          queryParams: { acao: null },
          queryParamsHandling: 'merge',
          replaceUrl: true,
        });
      });
    });
  }

  /** While a cut runs the page asks again; the player is not touched (FR-6). */
  private followCut(): void {
    toObservable(this.cutting)
      .pipe(
        distinctUntilChanged(),
        switchMap((on) => (on ? interval(this.pollMs) : EMPTY)),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.view.reload());
    let wasCutting = false;
    effect(() => {
      const cutting = this.cutting();
      const done = wasCutting && !cutting && this.cut() === 'none';
      wasCutting = cutting;
      if (done)
        untracked(() => {
          this.cutDone.set(true);
          this.changed.emit(null);
        });
    });
  }

  protected toggleHistory(event: Event): void {
    const details = event.target as HTMLDetailsElement;
    this.historyOpen.set(details.open);
  }

  protected saved(item: MediaItem): void {
    this.open.set(null);
    this.view.reload();
    this.changed.emit(item);
  }

  protected closeDialog(): void {
    this.open.set(null);
    this.editButton()?.nativeElement.focus();
  }

  protected deleted(): void {
    this.open.set(null);
    this.changed.emit(null);
  }

  protected retryCut(): void {
    const track = this.current();
    if (!track) return;
    this.failure.set('');
    this.api
      .retryCut(track)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.view.reload(),
        error: (err: unknown) =>
          this.failure.set(errorMessage(toUiErrorCode(err))),
      });
  }

  protected restore(): void {
    this.restoring.set(true);
    this.failure.set('');
    this.api
      .restore(this.media().id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (item) => {
          this.restoring.set(false);
          this.changed.emit(item);
        },
        error: (err: unknown) => {
          this.restoring.set(false);
          this.failure.set(restoreFailureText(err));
        },
      });
  }
}
