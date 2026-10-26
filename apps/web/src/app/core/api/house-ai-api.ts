import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  aiAssignmentResultSchema,
  aiStatusSchema,
  aiTestResultSchema,
  freeModelListSchema,
  houseAiViewSchema,
  openRouterConnectResponseSchema,
  type AiAssignmentRequest,
  type AiStatus,
  type AiTestResult,
  type FreeModelList,
  type HouseAiUpdate,
  type HouseAiView,
  type OpenRouterPurpose,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const houseAiUrl = (): string => '/api/v1/house-ai';
export const freeModelsUrl = (): string => '/api/v1/ai/free-models';
export const aiStatusUrl = (): string => '/api/v1/ai/status';

/** "IA da aplicação" (KBC-022): the house account, its models and who gets it. */
@Injectable({ providedIn: 'root' })
export class HouseAiApi {
  private readonly http = inject(HttpClient);

  view(): Observable<HouseAiView> {
    return this.http
      .get(houseAiUrl())
      .pipe(map((body) => houseAiViewSchema.parse(body)));
  }

  save(update: HouseAiUpdate): Observable<HouseAiView> {
    return this.http
      .put(houseAiUrl(), update)
      .pipe(map((body) => houseAiViewSchema.parse(body)));
  }

  test(): Observable<AiTestResult> {
    return this.http
      .post(`${houseAiUrl()}/test`, null)
      .pipe(map((body) => aiTestResultSchema.parse(body)));
  }

  disconnect(): Observable<void> {
    return this.http.delete(`${houseAiUrl()}/key`).pipe(map(() => undefined));
  }

  /** Where to send the browser for "Conectar OpenRouter" (OAuth PKCE on the server). */
  connect(purpose: OpenRouterPurpose): Observable<string> {
    return this.http
      .post('/api/v1/openrouter/connect', { purpose })
      .pipe(
        map((body) => openRouterConnectResponseSchema.parse(body).authorizeUrl),
      );
  }

  freeModels(): Observable<FreeModelList> {
    return this.http
      .get(freeModelsUrl())
      .pipe(map((body) => freeModelListSchema.parse(body)));
  }

  status(): Observable<AiStatus> {
    return this.http
      .get(aiStatusUrl())
      .pipe(map((body) => aiStatusSchema.parse(body)));
  }

  /** One app AI for several people or everyone (masters). */
  assign(request: AiAssignmentRequest): Observable<number> {
    return this.http
      .post('/api/v1/people/ai-assignment', request)
      .pipe(map((body) => aiAssignmentResultSchema.parse(body).updated));
  }
}
