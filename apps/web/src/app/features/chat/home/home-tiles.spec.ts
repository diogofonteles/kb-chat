import type { ConversationSummary } from '@kb-chat/contracts';
import { aTopic } from '../../../testing/fixtures.js';
import { homeTiles } from './home-tiles.js';

const summary = (
  id: string,
  updatedAt: string,
  topic = 'hermetismo',
): ConversationSummary => ({
  id,
  kind: 'search',
  topic,
  title: id,
  updatedAt,
  count: 1,
});

const topics = [
  aTopic({ slug: 'hermetismo', title: 'Hermetismo' }),
  aTopic({ slug: 'alquimia', title: 'Alquimia' }),
  aTopic({ slug: 'grupo', title: 'Grupo', canOpen: false }),
];

describe('homeTiles (KBC-126 FR-1)', () => {
  it('lists the conversations by their last use, then the collections they used, then the others', () => {
    const tiles = homeTiles(
      [
        summary('a', '2026-11-16T10:01:00.000Z'),
        summary('b', '2026-11-16T10:03:00.000Z', 'alquimia'),
        summary('c', '2026-11-16T10:02:00.000Z'),
      ],
      topics,
    );
    expect(tiles.map((tile) => tile.key)).toEqual([
      'conversation:b',
      'conversation:c',
      'conversation:a',
      'collection:alquimia',
      'collection:hermetismo',
    ]);
  });

  it('stops at six and leaves out a collection the person cannot open (KBC-110)', () => {
    const many = Array.from({ length: 8 }, (_, n) =>
      summary(`q${n}`, `2026-11-16T10:0${n}:00.000Z`, 'grupo'),
    );
    const tiles = homeTiles(many, topics);
    expect(tiles).toHaveLength(6);
    expect(tiles[0]?.key).toBe('conversation:q7');
    expect(homeTiles([], topics).map((tile) => tile.key)).toEqual([
      'collection:hermetismo',
      'collection:alquimia',
    ]);
  });
});
