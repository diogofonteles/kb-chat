import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  linkedSignal,
  output,
} from '@angular/core';
import { httpResource } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import {
  SEE_ALSO_GROUPS,
  SUBJECT_TRACKS_PAGE_MAX,
  subjectTracksPageSchema,
  type DocumentRef,
  type RelatedDocument,
  type SeeAlso,
  type SeeAlsoGroupName,
  type SubjectTrack,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { KbApi, subjectTracksUrl } from '@core/api/kb-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { describeFacets } from '@core/i18n/facet-labels.js';
import type { TrackOpening } from '@features/research/track-opening.js';

const GROUP_TITLES: Record<SeeAlsoGroupName, string> = {
  exampleOf: $localize`:@@seeAlso.exampleOf:É exemplo de`,
  extends: $localize`:@@seeAlso.extends:Aprofunda`,
  related: $localize`:@@seeAlso.related:Relacionados`,
  examples: $localize`:@@seeAlso.examples:Exemplos`,
  extendedBy: $localize`:@@seeAlso.extendedBy:Aprofundado por`,
  relatedFrom: $localize`:@@seeAlso.relatedFrom:Relacionados a este assunto`,
};

interface ItemView extends DocumentRef {
  readonly facets: string;
  /** A track kb linked (KBC-101 FR-6): it opens the T22 panel, not the document. */
  readonly media?: RelatedDocument['media'];
}

interface GroupView {
  readonly name: SeeAlsoGroupName;
  readonly title: string;
  readonly items: readonly ItemView[];
  readonly total: number;
  readonly loading: boolean;
  readonly failed: boolean;
}

/** References loaded per "Ver mais" click. */
const PAGE_SIZE = 50;

const toItem = (ref: RelatedDocument): ItemView => ({
  id: ref.id,
  title: ref.title,
  facets: describeFacets(ref),
  ...(ref.media && { media: ref.media }),
});

/**
 * "Veja também" in the document panel (screens.md T3, KBC-003 BR-1/BR-3); on a concept's
 * article, with the tracks about it for who sees subjects (KBC-070 FR-3).
 */
@Component({
  selector: 'app-see-also',
  imports: [RouterLink],
  templateUrl: './see-also.html',
  styleUrl: './see-also.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SeeAlsoSection {
  private readonly api = inject(KbApi);
  private readonly destroyRef = inject(DestroyRef);
  private readonly session = inject(SessionStore);

  readonly topic = input.required<string>();
  readonly documentId = input.required<string>();
  readonly seeAlso = input.required<SeeAlso>();
  /** The concept this article is about; null on a source. */
  readonly concept = input<string | null>(null);
  readonly opened = output<DocumentRef>();
  /** A linked track opens at its start, with "← Voltar" to this document (KBC-101 AC-7). */
  readonly trackOpened = output<TrackOpening>();

  /** Items loaded with "ver todos", reset whenever another document is shown. */
  private readonly expanded = linkedSignal<
    SeeAlso,
    Partial<Record<SeeAlsoGroupName, readonly RelatedDocument[]>>
  >({
    source: this.seeAlso,
    computation: () => ({}),
  });

  /** Groups with a "Ver mais" request in flight or failed (one request per group at a time). */
  private readonly loading = linkedSignal<
    SeeAlso,
    ReadonlySet<SeeAlsoGroupName>
  >({
    source: this.seeAlso,
    computation: () => new Set(),
  });
  private readonly failed = linkedSignal<
    SeeAlso,
    ReadonlySet<SeeAlsoGroupName>
  >({
    source: this.seeAlso,
    computation: () => new Set(),
  });

  private readonly tracksUrl = computed(() => {
    const concept = this.concept();
    const allowed =
      this.session.can('media') &&
      this.session.can('media-tracks') &&
      this.session.can('media-subjects');
    return concept && allowed
      ? subjectTracksUrl(this.topic(), concept)
      : undefined;
  });
  private readonly firstTracks = httpResource(() => this.tracksUrl(), {
    parse: (body) => subjectTracksPageSchema.parse(body),
  });
  /** Tracks loaded with "Ver todas", reset with the document. */
  private readonly moreTracks = linkedSignal<
    string | undefined,
    readonly SubjectTrack[]
  >({ source: this.tracksUrl, computation: () => [] });
  protected readonly tracksLoading = linkedSignal(() => {
    this.tracksUrl();
    return false;
  });
  protected readonly moreTracksFailed = linkedSignal(() => {
    this.tracksUrl();
    return false;
  });
  protected readonly tracks = computed(() =>
    this.firstTracks.hasValue()
      ? [...this.firstTracks.value().items, ...this.moreTracks()]
      : [],
  );
  protected readonly tracksTotal = computed(() =>
    this.firstTracks.hasValue() ? this.firstTracks.value().total : 0,
  );
  protected readonly tracksFailed = computed(
    () => this.firstTracks.error() !== undefined,
  );
  protected readonly durationOf = (track: SubjectTrack): string =>
    track.durationMs === null ? '' : formatClock(track.durationMs);

  protected readonly groups = computed<GroupView[]>(() =>
    SEE_ALSO_GROUPS.map((name) => ({
      name,
      title: GROUP_TITLES[name],
      items: (this.expanded()[name] ?? this.seeAlso()[name].items).map(toItem),
      total: this.seeAlso()[name].total,
      loading: this.loading().has(name),
      failed: this.failed().has(name),
    })).filter((group) => group.total > 0),
  );

  protected openTrack(ref: ItemView, event: Event): void {
    if (!ref.media) return;
    const trigger =
      event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.trackOpened.emit({
      source: { n: 1, id: ref.id, title: ref.title, media: ref.media },
      at: '',
      trigger,
    });
  }

  /** The rest of the tracks, up to a full page at a time. */
  protected showAllTracks(): void {
    const concept = this.concept();
    if (!concept || this.tracksLoading()) return;
    this.tracksLoading.set(true);
    this.moreTracksFailed.set(false);
    // A late answer belongs to the concept the person left: it must not land on this one.
    const asked = this.tracksUrl();
    const isCurrent = () => this.tracksUrl() === asked;
    this.api
      .subjectTracks(this.topic(), concept, {
        offset: this.tracks().length,
        limit: SUBJECT_TRACKS_PAGE_MAX,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          if (!isCurrent()) return;
          this.moreTracks.update((all) => [...all, ...page.items]);
          this.tracksLoading.set(false);
        },
        error: () => {
          if (!isCurrent()) return;
          this.moreTracksFailed.set(true);
          this.tracksLoading.set(false);
        },
      });
  }

  /** Loads the next page of a group; ignored while that group is already loading. */
  protected showMore(group: GroupView): void {
    if (group.loading) return;
    const already =
      this.expanded()[group.name] ?? this.seeAlso()[group.name].items;
    this.loading.update((names) => new Set([...names, group.name]));
    this.failed.update(
      (names) => new Set([...names].filter((name) => name !== group.name)),
    );
    this.api
      .relations(this.topic(), this.documentId(), {
        group: group.name,
        offset: already.length,
        limit: PAGE_SIZE,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (page) => {
          this.expanded.update((all) => ({
            ...all,
            [group.name]: [...already, ...page.items],
          }));
          this.done(group.name);
        },
        error: () => {
          this.failed.update((names) => new Set([...names, group.name]));
          this.done(group.name);
        },
      });
  }

  private done(name: SeeAlsoGroupName): void {
    this.loading.update(
      (names) => new Set([...names].filter((n) => n !== name)),
    );
  }
}
