import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { AuthApi } from '@core/auth/auth-api.js';

/**
 * The public privacy policy (KBC-016): what Nova Alexandria keeps, why, who takes part,
 * for how long and how to ask for deletion. Opens without a session; the contact for data
 * requests is the owner's email from the API config, never written in the code.
 */
@Component({
  selector: 'app-privacy-page',
  imports: [RouterLink],
  templateUrl: './privacy-page.html',
  styleUrl: './privacy-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PrivacyPage {
  private readonly api = inject(AuthApi);
  private readonly config = rxResource({ stream: () => this.api.config() });

  protected readonly loading = this.config.isLoading;
  /** Null on error or when the API names no contact. */
  protected readonly contact = computed(() =>
    this.config.hasValue() ? this.config.value().privacyContactEmail : null,
  );
}
