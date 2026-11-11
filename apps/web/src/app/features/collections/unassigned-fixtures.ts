import { HttpResponse, type HttpInterceptorFn } from '@angular/common/http';
import type { UnassignedDocument, UnassignedPage } from '@kb-chat/contracts';
import { of } from 'rxjs';

/** A document of the "Sem nível" queue, as the API lists it (KBC-107). */
export const unassignedDoc = (
  n: number,
  over: Partial<UnassignedDocument> = {},
): UnassignedDocument => ({
  topic: 'hermetismo',
  id: `raw/novo-${n}.md`,
  title: `Novo ${n}`,
  origin: 'text',
  authorship: 'outros-autores',
  author: null,
  folder: 'raw',
  firstSeenAt: '2026-11-05T10:00:00.000Z',
  ...over,
});

/** One page of the queue: `count` documents in all, `items` of them on the page. */
export const unassignedPage = (
  {
    count,
    items = Math.min(count, 10),
    origin = 'text',
  }: { count: number; items?: number; origin?: UnassignedDocument['origin'] },
  over: Partial<UnassignedPage> = {},
): UnassignedPage => ({
  collection: 'hermetismo',
  total: count,
  matched: count,
  asOf: '2026-11-11T12:00:00.000Z',
  items: Array.from({ length: items }, (_, n) => unassignedDoc(n, { origin })),
  nextCursor: items < count ? 'next' : null,
  facets: {
    collections: [{ value: 'hermetismo', count }],
    origins: count > 0 ? [{ value: origin, count }] : [],
    authorships: count > 0 ? [{ value: 'outros-autores', count }] : [],
    folders: count > 0 ? [{ value: 'raw', count }] : [],
  },
  levels: [
    { id: 'qs', code: 'QS' },
    { id: 'ci', code: 'CI' },
  ],
  ...over,
});

/** Answers every "Sem nível" page with `page` at once (a page under test that is not it). */
export const answeringUnassigned =
  (page: UnassignedPage): HttpInterceptorFn =>
  (request, next) =>
    /\/levels\/unassigned(\?|$)/.test(request.url)
      ? of(new HttpResponse({ status: 200, body: page }))
      : next(request);
