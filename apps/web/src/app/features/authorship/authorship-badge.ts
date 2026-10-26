import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import type { Authorship } from '@kb-chat/contracts';
import { AUTHORSHIP_LABELS } from '@core/i18n/facet-labels.js';

/**
 * Whose text a document is (KBC-020, screens.md T2): the Mestre Laércio badge is filled and
 * carries a ✦, other authors are outlined, a synthesis dashed and an unclassified one dotted,
 * so the label, the mark and the shape tell them apart, not color alone (BR-3). Without an
 * authorship (a turn saved before KBC-020) nothing is drawn.
 */
@Component({
  selector: 'app-authorship-badge',
  templateUrl: './authorship-badge.html',
  styleUrl: './authorship-badge.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AuthorshipBadge {
  readonly authorship = input<Authorship | undefined>(undefined);

  protected readonly label = computed(() => {
    const authorship = this.authorship();
    return authorship ? AUTHORSHIP_LABELS[authorship] : '';
  });
  protected readonly mestre = computed(
    () => this.authorship() === 'mestre-laercio',
  );
}
