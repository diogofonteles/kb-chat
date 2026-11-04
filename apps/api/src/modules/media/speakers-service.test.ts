import { describe, expect, it } from 'vitest';
import { openMediaDatabase } from '../../adapters/sqlite/media-database.js';
import { MEDIA_MIGRATIONS } from '../../adapters/sqlite/media-migrations.js';
import { SqliteSpeakerStore } from '../../adapters/sqlite/sqlite-speaker-store.js';
import { SpeakersService } from './speakers-service.js';

const AUTHORS: Record<string, string> = { ana: 'Ana', bia: 'Bia' };

const aService = () =>
  new SpeakersService({
    speakers: new SqliteSpeakerStore(
      openMediaDatabase(':memory:', MEDIA_MIGRATIONS),
    ),
    rootOf: (topic) => topic,
    authorOf: (_collection, slug) => {
      const name = AUTHORS[slug];
      return name ? { name, main: false } : null;
    },
  });

describe('SpeakersService.add (KBC-065 FR-1, BR-2)', () => {
  it('finds a speaker by its author before another one by the name', () => {
    const service = aService();
    const byName = service.add('udv', { name: 'Zé', authorSlug: 'bia' }, 'a');
    const byAuthor = service.add('udv', { name: 'Ana', authorSlug: 'ana' }, 'a');
    const asked = { name: 'Zé', authorSlug: 'ana' };
    const { speaker, created } = service.add('udv', asked, 'a');
    expect(speaker.id).toBe(byAuthor.speaker.id);
    expect(speaker.id).not.toBe(byName.speaker.id);
    expect(created).toBe(false);
  });

  it("refuses a name that is another author's speaker", () => {
    const service = aService();
    service.add('udv', { name: 'Zé', authorSlug: 'ana' }, 'a');
    expect(() =>
      service.add('udv', { name: 'Zé', authorSlug: 'bia' }, 'a'),
    ).toThrowError(expect.objectContaining({ code: 'MEDIA_CONFLICT' }));
  });
});
