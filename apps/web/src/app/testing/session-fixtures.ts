import type { Me } from '@kb-chat/contracts';

/** Who is signed in: a guest with search on hermetismo by default. */
export const aMe = (overrides: Partial<Me> = {}): Me => ({
  email: 'guest@example.com',
  name: 'Guest',
  picture: null,
  role: 'member',
  features: ['search'],
  topics: ['hermetismo'],
  isOwner: false,
  media: false,
  canActAs: false,
  actingAs: null,
  ...overrides,
});

export const anOwner = (): Me =>
  aMe({
    email: 'owner@example.com',
    name: 'Owner',
    role: 'master',
    features: [
      'search',
      'research',
      'collection-builder',
      'own-ai-settings',
      'media',
      'media-upload',
    ],
    topics: ['alquimia', 'hermetismo'],
    isOwner: true,
    canActAs: true,
  });
