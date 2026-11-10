import { HttpResponse, type HttpInterceptorFn } from '@angular/common/http';
import type { LevelChoice, MediaLevelChoices } from '@kb-chat/contracts';
import { Subject, map, of, take } from 'rxjs';

const LEVELS_URL = /^\/api\/v1\/topics\/([^/]+)\/media\/levels$/;

/** QS < CI, as a member at CI is offered them (KBC-105 AC-2). */
export const QS_CI: readonly LevelChoice[] = [
  { id: 'qs', code: 'QS' },
  { id: 'ci', code: 'CI' },
];

/**
 * Answers "what levels may an upload here take" (KBC-105) for each collection: its scale
 * as given, none for any other. `rootOf` names the top-level collection of a slug.
 */
export const answeringLevels =
  (
    scales: Readonly<Record<string, readonly LevelChoice[]>> = {},
    rootOf: (slug: string) => string = (slug) => slug.split('/')[0] ?? slug,
  ): HttpInterceptorFn =>
  (request, next) => {
    const match = LEVELS_URL.exec(request.url);
    if (!match?.[1]) return next(request);
    const topic = decodeURIComponent(match[1]);
    const collection = rootOf(topic);
    const body: MediaLevelChoices = {
      collection,
      levels: [...(scales[collection] ?? [])],
    };
    return of(new HttpResponse({ status: 200, body }));
  };

/**
 * Holds the answer about `topic`'s levels until `release` (KBC-105 review: a click while they
 * load); other collections go on to the next interceptor.
 */
export function holdingLevels(topic: string): {
  readonly interceptor: HttpInterceptorFn;
  release(levels?: readonly LevelChoice[]): void;
} {
  const answer = new Subject<readonly LevelChoice[]>();
  return {
    interceptor: (request, next) => {
      const match = LEVELS_URL.exec(request.url);
      if (decodeURIComponent(match?.[1] ?? '') !== topic) return next(request);
      return answer.pipe(
        take(1),
        map(
          (levels) =>
            new HttpResponse<MediaLevelChoices>({
              status: 200,
              body: { collection: topic, levels: [...levels] },
            }),
        ),
      );
    },
    release: (levels = []) => answer.next(levels),
  };
}
