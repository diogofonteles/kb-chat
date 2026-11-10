import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ContentLevel } from '@kb-chat/contracts';

/**
 * An audio's level on its line, for masters (KBC-105 AC-11, ADR 0036 §9): "Nível: CI", or
 * "Sem nível" with the warning sign. Nothing when the API sent no level (members, or a
 * collection without levels).
 */
@Component({
  selector: 'app-media-level-badge',
  template: `
    @if (shown()) {
      @if (level(); as known) {
        <span class="badge" i18n="@@mediaLevel.badge"
          >Nível: {{ known.code }}</span
        >
      } @else if (level() === null) {
        <span class="badge unassigned" i18n="@@mediaLevel.none"
          ><span aria-hidden="true">⚠</span> Sem nível</span
        >
      }
    }
  `,
  styles: `
    .badge {
      padding: 0 var(--space-2);
      border: 1px solid var(--color-accent-strong);
      border-radius: 999px;
      color: var(--color-accent-strong);
      font-size: var(--text-sm);
      font-weight: 600;
      white-space: nowrap;
    }
    .unassigned {
      border-color: var(--color-danger);
      color: var(--color-danger);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MediaLevelBadge {
  /** The item's level as the API sent it; undefined: none to show. */
  readonly level = input<ContentLevel | undefined>(undefined);
  /** Only masters see badges; an editor gets the level for the field only. */
  readonly shown = input(false);
}
