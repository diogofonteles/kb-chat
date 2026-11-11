import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { Authorship, MediaAuthor } from '@kb-chat/contracts';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';
import { injectAuthorshipLabels } from './authorship-labels.js';

/**
 * Whose text a document is (KBC-020, screens.md T2): the main author's badge is filled and
 * carries a ✦, other authors are outlined, a synthesis dashed and an unclassified one dotted,
 * so the label, the mark and the shape tell them apart, not color alone (BR-3). Without an
 * authorship (a turn saved before KBC-020) nothing is drawn. A media item (KBC-049) shows
 * its author by name, ✦ when the main one, and "Outros autores" when it has none.
 */
@Component({
  selector: 'app-authorship-badge',
  templateUrl: './authorship-badge.html',
  styleUrl: './authorship-badge.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthorshipBadge {
  readonly authorship = input<Authorship | undefined>(undefined);
  /** A media item's author (null: none); when given, it is what the badge shows. */
  readonly mediaAuthor = input<MediaAuthor | undefined>(undefined);

  private readonly labels = injectAuthorshipLabels();

  /** The shape: a media author counts as the main group or the others. */
  protected readonly group = computed((): Authorship | undefined => {
    const author = this.mediaAuthor();
    if (author !== undefined)
      return author?.main ? 'mestre-laercio' : 'outros-autores';
    return this.authorship();
  });
  protected readonly label = computed(() => {
    const author = this.mediaAuthor();
    if (author) return author.name;
    if (author === null) return AUTHORSHIP_LABELS['outros-autores'];
    const authorship = this.authorship();
    return authorship ? this.labels()[authorship] : '';
  });
  protected readonly mestre = computed(() => this.group() === 'mestre-laercio');
}
