import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import {
  MEDIA_COUNT_CAP,
  type KindCounts,
  type SearchKind,
} from '@kb-chat/contracts';
import { ALL_KINDS, toggleKind } from './search-kinds.js';

const LABELS: Record<SearchKind, () => string> = {
  text: () => $localize`:@@kinds.text:Textos`,
  audio: () => $localize`:@@kinds.audio:Áudios`,
};

interface KindOption {
  readonly kind: SearchKind;
  readonly label: string;
  readonly count: string;
  readonly selected: boolean;
  readonly disabled: boolean;
}

const countText = (count: number | null): string => {
  if (count === null) return '';
  return count >= MEDIA_COUNT_CAP ? `${MEDIA_COUNT_CAP}+` : String(count);
};

/**
 * "Buscar em: Textos · Áudios" (KBC-039 FR-5, screens.md T2): check boxes drawn like the
 * "Autoria" segments, with the matches of each kind. The last one chosen cannot be
 * unchecked (BR-4); a kind the collection does not have is disabled.
 */
@Component({
  selector: 'app-kinds-choice',
  templateUrl: './kinds-choice.html',
  styleUrl: './kinds-choice.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class KindsChoice {
  readonly kinds = input.required<readonly SearchKind[]>();
  readonly counts = input.required<KindCounts>();
  readonly changed = output<SearchKind[]>();

  protected readonly titleId = `kinds-${Math.random().toString(36).slice(2, 9)}`;
  /** The kinds chosen that the collection has: the ones that really search. */
  private readonly chosen = computed(() =>
    this.kinds().filter((kind) => this.counts()[kind] !== null),
  );
  protected readonly options = computed((): KindOption[] => {
    const chosen = this.chosen();
    const counts = this.counts();
    return ALL_KINDS.map((kind) => {
      const count = counts[kind];
      const selected = chosen.includes(kind);
      const absent = count === null;
      return {
        kind,
        label: LABELS[kind](),
        count: countText(count),
        selected,
        disabled: absent || (selected && chosen.length === 1),
      };
    });
  });

  protected toggle(kind: SearchKind): void {
    this.changed.emit(toggleKind(this.chosen(), kind));
  }
}
