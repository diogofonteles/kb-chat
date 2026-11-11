import { Injectable, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type {
  InviteProfileView,
  InviteProfileCreate,
  InviteProfileUpdate,
} from '@kb-chat/contracts';
import { InviteProfilesApi } from '@core/api/invite-profiles-api.js';
import { tap, type Observable } from 'rxjs';

/**
 * The house's invitation profiles (KBC-028), shared by the invitation, the profiles section
 * and "Aplicar perfil". Marking one as default changes the others: each write reloads.
 */
@Injectable()
export class InviteProfilesStore {
  private readonly api = inject(InviteProfilesApi);
  private readonly resource = rxResource({ stream: () => this.api.list() });
  readonly list = computed<readonly InviteProfileView[]>(() =>
    this.resource.hasValue() ? this.resource.value() : [],
  );
  readonly failed = computed(() => this.resource.error() !== undefined);
  readonly defaultProfile = computed(
    () => this.list().find((profile) => profile.isDefault) ?? null,
  );

  find(id: string): InviteProfileView | null {
    return this.list().find((profile) => profile.id === id) ?? null;
  }

  reload(): void {
    this.resource.reload();
  }

  create(profile: InviteProfileCreate): Observable<InviteProfileView> {
    return this.api.create(profile).pipe(tap(() => this.reload()));
  }

  update(
    id: string,
    patch: InviteProfileUpdate,
  ): Observable<InviteProfileView> {
    return this.api.update(id, patch).pipe(tap(() => this.reload()));
  }

  remove(id: string): Observable<void> {
    return this.api.remove(id).pipe(tap(() => this.reload()));
  }
}
