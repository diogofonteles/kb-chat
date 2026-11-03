import { aMediaItem } from '../../testing/media-fixtures.js';
import {
  ANY_AUTHOR,
  NO_AUTHOR,
  authorFilterOptions,
  matchesAuthor,
} from './media-authors.js';

const gabriel = { slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: true };
const ana = { slug: 'ana', name: 'Ana', main: false };
const ITEMS = [
  aMediaItem({ id: '1', author: ana }),
  aMediaItem({ id: '2', author: gabriel }),
  aMediaItem({ id: '3', author: null }),
  aMediaItem({ id: '4', author: gabriel }),
];

describe('the media "Autoria" filter (KBC-049 FR-4)', () => {
  it('lists the main author first, said in words, the others by name, then "Outros autores"', () => {
    expect(authorFilterOptions(ITEMS)).toEqual([
      {
        value: 'mestre-gabriel',
        label: 'Mestre Gabriel (principal)',
        count: 2,
      },
      { value: 'ana', label: 'Ana', count: 1 },
      { value: NO_AUTHOR, label: 'Outros autores', count: 1 },
    ]);
  });

  it('keeps the items of the chosen author, the ones with none, or all', () => {
    const ids = (chosen: string) =>
      ITEMS.filter((item) => matchesAuthor(item, chosen)).map((i) => i.id);
    expect(ids('mestre-gabriel')).toEqual(['2', '4']);
    expect(ids(NO_AUTHOR)).toEqual(['3']);
    expect(ids(ANY_AUTHOR)).toEqual(['1', '2', '3', '4']);
  });
});
