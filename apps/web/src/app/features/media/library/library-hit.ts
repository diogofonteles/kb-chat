import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { UiCover } from '@ui/cover.js';
import { UiIcon } from '@ui/icon.js';
import type { LibraryHit as Hit } from '@kb-chat/contracts';
import { formatClock, formatDuration } from '@kb-chat/player-core';
import { speak } from '@core/i18n/spoken-time.js';
import { textParts } from '@core/text/text-parts.js';
import { playbackStartOf } from '../search-hit/passage-focus.js';
import { MenuButton, type MenuOption } from '../menu-button.js';
import { PlayNow } from './play-now.js';

/**
 * One result of "Buscar na biblioteca" (KBC-096): ▶, the track's title, where it belongs and
 * the sentence with the words marked, at its time. Both go to that point, 2 s before it.
 */
/** How much of the words before the mark the phone's line keeps. */
const LEAD_CHARS = 16;

@Component({
  selector: 'app-library-hit',
  imports: [RouterLink, MenuButton, UiCover, UiIcon],
  templateUrl: './library-hit.html',
  styleUrl: './library-hit.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LibraryHit {
  readonly hit = input.required<Hit>();
  readonly playing = input(false);
  readonly played = output();
  readonly opened = output();
  private readonly playNow = inject(PlayNow);
  private readonly router = inject(Router);

  protected readonly options: readonly MenuOption[] = [
    {
      id: 'play',
      label: $localize`:@@library.playNow:Tocar agora`,
      icon: 'play',
    },
    {
      id: 'play-next',
      label: $localize`:@@library.playNext:Tocar em seguida`,
      icon: 'queue',
    },
    {
      id: 'bookmarks',
      label: $localize`:@@library.seeBookmarks:Ver marcadores`,
      icon: 'bookmark',
    },
  ];
  protected readonly menuLabel = computed(
    () =>
      $localize`:@@media.moreActions:Mais ações para ${this.item().title}:title:`,
  );

  protected choose(id: string): void {
    if (id === 'play') {
      if (!this.playing()) this.played.emit();
    } else if (id === 'play-next') this.playNow.playNext(this.item());
    else if (id === 'bookmarks')
      void this.router.navigate(['/midia', this.item().id], {
        fragment: 'marcadores',
      });
  }

  protected readonly item = computed(() => this.hit().item);
  protected readonly passage = computed(() => this.hit().passage);
  protected readonly clock = computed(() =>
    formatClock(this.passage()?.startMs ?? 0),
  );
  protected readonly spokenClock = computed(() =>
    speak(this.passage()?.startMs ?? 0),
  );
  /** The passage's parts, its quotes in the words (“…”, as drawn in media-library-search). */
  protected readonly parts = computed(() => {
    const passage = this.passage();
    if (!passage) return [];
    const parts = textParts(passage.text, passage.highlights);
    return [
      { text: '“', marked: false },
      ...parts,
      { text: '”', marked: false },
    ];
  });
  /**
   * The phone's one line (media-library-search@mobile: "“…plateia sobre o vegetal.”"): the
   * words before the first mark cut to the last few, so the mark is always in sight.
   */
  protected readonly shortParts = computed(() => {
    const parts = this.parts();
    const first = parts.findIndex((part) => part.marked);
    if (first < 0) return parts;
    const before = parts
      .slice(1, first)
      .map((part) => part.text)
      .join('');
    if (before.length <= LEAD_CHARS) return parts;
    const words = before.split(/(\s+)/);
    let kept = '';
    for (let at = words.length - 1; at >= 0; at--) {
      const next = (words[at] ?? '') + kept;
      if (next.trim().length > LEAD_CHARS) break;
      kept = next;
    }
    return [
      { text: '“…' + kept.trimStart(), marked: false },
      ...parts.slice(first),
    ];
  });
  /** The whole passage in words, for a screen reader where the line is cut (a phone). */
  protected readonly spokenPassage = computed(() =>
    this.parts()
      .map((part) => part.text)
      .join(''),
  );
  protected readonly low = computed(() => this.passage()?.confidence === 'low');
  protected readonly bySubject = computed(() => this.hit().match === 'subject');
  /** `?t=` of the player (KBC-038 FR-5): none without a passage, so it resumes. */
  protected readonly startParams = computed(() => {
    const passage = this.passage();
    return passage ? { t: Math.floor(playbackStartOf(passage) / 1000) } : {};
  });
  protected readonly duration = computed(() => {
    const { durationMs } = this.item();
    return durationMs === null ? '' : formatDuration(durationMs);
  });
  /** The album it belongs to, or that it is the album. */
  protected readonly place = computed(() => {
    const { parent } = this.item();
    const { trackCount } = this.hit();
    if (parent?.ordinal != null)
      return $localize`:@@library.hit.track:${parent.title}:title: · faixa ${parent.ordinal}:ordinal: de ${parent.total}:total:`;
    if (parent) return parent.title;
    if (trackCount === 0) return '';
    return trackCount === 1
      ? $localize`:@@library.hit.recordingOne:Gravação completa · 1 faixa`
      : $localize`:@@library.hit.recording:Gravação completa · ${trackCount}:count: faixas`;
  });
  /** The album, the author by name ("Outros autores" with none) and the length, plain. */
  protected readonly meta = computed(() =>
    [
      this.place(),
      this.item().author?.name ??
        $localize`:@@authorship.others:Outros autores`,
      this.duration(),
    ]
      .filter((part) => part !== '')
      .join(' · '),
  );
  protected readonly playLabel = computed(() => {
    const { title } = this.item();
    if (this.playing())
      return $localize`:@@library.pauseTrack:Pausar ${title}:title:`;
    return this.passage()
      ? $localize`:@@library.hit.playPassage:Ouvir o trecho de ${title}:title: aos ${this.spokenClock()}:time:`
      : $localize`:@@library.playTrack:Ouvir ${title}:title:`;
  });
}
