import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  aiTestResultSchema,
  providerListSchema,
  settingsViewSchema,
  type AiTestRequest,
  type AiTestResult,
  type ProviderList,
  type SettingsUpdate,
  type SettingsView,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const settingsUrl = (): string => '/api/v1/settings';
export const providersUrl = (): string => '/api/v1/ai/providers';
export const aiTestUrl = (): string => '/api/v1/settings/ai/test';

/** Settings and AI providers (KBC-007): keys go up, never come back (BR-1). */
@Injectable({ providedIn: 'root' })
export class SettingsApi {
  private readonly http = inject(HttpClient);

  settings(): Observable<SettingsView> {
    return this.http
      .get(settingsUrl())
      .pipe(map((body) => settingsViewSchema.parse(body)));
  }

  save(update: SettingsUpdate): Observable<SettingsView> {
    return this.http
      .put(settingsUrl(), update)
      .pipe(map((body) => settingsViewSchema.parse(body)));
  }

  providers(): Observable<ProviderList> {
    return this.http
      .get(providersUrl())
      .pipe(map((body) => providerListSchema.parse(body)));
  }

  test(request: AiTestRequest): Observable<AiTestResult> {
    return this.http
      .post(aiTestUrl(), request)
      .pipe(map((body) => aiTestResultSchema.parse(body)));
  }
}
