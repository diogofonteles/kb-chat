import { signal } from '@angular/core';
import type {
  Feature,
  MediaItem,
  MediaTranscription,
} from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { aTopic } from './fixtures.js';

/** A valid media id (the contract requires UUIDs): the n-th of a list. */
export const mediaId = (n: number): string =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A media item of the library (KBC-034), ready by default. */
export const aMediaItem = (overrides: Partial<MediaItem> = {}): MediaItem => ({
  id: '11111111-1111-4111-8111-111111111111',
  topic: 'hermetismo',
  title: 'Palestra de 1998',
  author: { slug: 'mestre-laercio', name: 'Mestre Laércio', main: true },
  status: 'ready',
  progress: null,
  failure: null,
  durationMs: 3_735_000,
  bytes: 30_000_000,
  createdAt: '2026-10-28T12:00:00.000Z',
  canRetry: false,
  canEdit: false,
  positionMs: 0,
  completedAt: null,
  positionUpdatedAt: null,
  transcription: aTranscription(),
  ...overrides,
});

/** A media item's transcription (KBC-036): not asked yet by default. */
export const aTranscription = (
  overrides: Partial<MediaTranscription> = {},
): MediaTranscription => ({
  status: 'none',
  confidence: null,
  version: null,
  transcriber: 'none',
  transcriberOffSince: null,
  ...overrides,
});

/** The chat page's store as the media pages read it: the selected collection. */
export const chatStoreOn = (slug = 'hermetismo', title = 'Hermetismo') => ({
  provide: ChatStore,
  useValue: {
    topicSlug: signal(slug),
    selectTopic: vi.fn(),
    topicsKnown: signal(true),
    topic: signal(aTopic({ slug, title, documentCount: 10 })),
    topicList: signal([
      aTopic({ slug, title, documentCount: 10 }),
      aTopic({ slug: 'alquimia', title: 'Alquimia', documentCount: 4 }),
    ]),
  },
});

/** Who is signed in, for the media pages: their features and whether they are a master. */
export const sessionAs = (who: { features: Feature[]; master?: boolean }) => ({
  provide: SessionStore,
  useValue: {
    can: (feature: Feature) => who.features.includes(feature),
    isMaster: signal(who.master ?? false),
    me: signal({ media: true }),
  },
});
