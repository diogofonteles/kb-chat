import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import {
  transcriptLearningSchema,
  type TranscriptLearning,
} from '@kb-chat/contracts';
import { map, type Observable } from 'rxjs';

export const learningUrl = (): string => '/api/v1/media/learning';

/** "Aprendido das correções" (KBC-113): masters switch a rule or a learned term. */
@Injectable({ providedIn: 'root' })
export class LearningApi {
  private readonly http = inject(HttpClient);

  switch(
    kind: 'rules' | 'terms',
    id: string,
    enabled: boolean | null,
  ): Observable<TranscriptLearning> {
    return this.http
      .put(`${learningUrl()}/${kind}/${id}`, { enabled })
      .pipe(map((body) => transcriptLearningSchema.parse(body)));
  }
}
