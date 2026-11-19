import {
  ReadingPage,
  type ReadingLink,
  type ReadingSection,
} from '@features/public/reading-page.js';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { AuthApi } from '@core/auth/auth-api.js';
import { UiIcon } from '@ui/icon.js';

/**
 * The public privacy policy (KBC-016): what Nova Alexandria keeps, why, who takes part,
 * for how long and how to ask for deletion. Opens without a session; the contact for data
 * requests is the owner's email from the API config, never written in the code.
 */
@Component({
  selector: 'app-privacy-page',
  imports: [RouterLink, ReadingPage, UiIcon],
  templateUrl: './privacy-page.html',
  styleUrl: './privacy-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrivacyPage {
  private readonly api = inject(AuthApi);
  private readonly config = rxResource({ stream: () => this.api.config() });

  protected readonly title = $localize`:@@privacy.title:Política de privacidade`;
  protected readonly updated = $localize`:@@privacy.updated:Última atualização: 4 de novembro de 2026.`;
  /** The index: one entry per h2 of the page, in order (KBC-124 FR-5). */
  protected readonly sections: readonly ReadingSection[] = [
    {
      id: 'privacy-data',
      title: $localize`:@@privacy.index.data:Quais dados guardamos`,
    },
    {
      id: 'privacy-purpose',
      title: $localize`:@@privacy.index.purpose:Para que usamos`,
    },
    {
      id: 'privacy-support',
      title: $localize`:@@privacy.index.support:Quando um master ajuda você`,
    },
    {
      id: 'privacy-parties',
      title: $localize`:@@privacy.index.parties:Quem participa`,
    },
    {
      id: 'privacy-retention',
      title: $localize`:@@privacy.index.retention:Por quanto tempo`,
    },
    {
      id: 'privacy-rights',
      title: $localize`:@@privacy.index.rights:Seus direitos`,
    },
  ];
  protected readonly other: ReadingLink = {
    label: $localize`:@@reading.tutorial:Como usar`,
    path: '/tutorial',
  };
  protected readonly loading = this.config.isLoading;
  /** Null on error or when the API names no contact. */
  protected readonly contact = computed(() =>
    this.config.hasValue() ? this.config.value().privacyContactEmail : null,
  );
}
