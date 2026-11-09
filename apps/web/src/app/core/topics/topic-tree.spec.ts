import { aTopic } from '../../testing/fixtures.js';
import {
  collectionChoices,
  openable,
  treeTitle,
  withTopic,
} from './topic-tree.js';

const UDV = aTopic({ slug: 'udv', title: 'UDV' });
const PALAVRA = aTopic({
  slug: 'udv/palavra-do-mestre',
  title: 'Palavra do Mestre',
  parent: 'udv',
});
const HERMETISMO = aTopic({ slug: 'hermetismo', title: 'Hermetismo' });

describe('topic tree (KBC-048)', () => {
  it('indents a sub-collection and leaves a top-level one as it is', () => {
    expect(treeTitle(UDV)).toBe('UDV');
    expect(treeTitle(PALAVRA)).toMatch(/^\u00a0{4}Palavra do Mestre$/);
  });

  it('leaves out a parent shown only as a group title', () => {
    const closed = { ...UDV, canOpen: false };
    expect(openable([closed, PALAVRA]).map((t) => t.slug)).toEqual([
      'udv/palavra-do-mestre',
    ]);
  });

  it('checks and locks a sub-collection given through its parent', () => {
    const rows = collectionChoices([UDV, PALAVRA, HERMETISMO], ['udv'], false);
    expect(rows.map((row) => [row.slug, row.checked, row.inherited])).toEqual([
      ['udv', true, false],
      ['udv/palavra-do-mestre', true, true],
      ['hermetismo', false, false],
    ]);
    expect(rows[1]?.parentTitle).toBe('UDV');
  });

  it('a sub-collection given alone is checked and free; a master has all, none locked', () => {
    const alone = collectionChoices([UDV, PALAVRA], [PALAVRA.slug], false);
    expect(alone.map((row) => [row.checked, row.inherited])).toEqual([
      [false, false],
      [true, false],
    ]);
    const master = collectionChoices([UDV, PALAVRA], [], true);
    expect(master.every((row) => row.checked && !row.inherited)).toBe(true);
  });
});

describe('withTopic (KBC-048 FR-3)', () => {
  it('puts a new sub-collection under its parent and a new collection in name order', () => {
    const zeta = aTopic({ slug: 'udv/zeta', title: 'Zeta', parent: 'udv' });
    const alfa = aTopic({ slug: 'alfa', title: 'Alfa' });
    const slugs = (list: readonly { slug: string }[]) =>
      list.map((t) => t.slug);
    expect(slugs(withTopic([UDV, PALAVRA, HERMETISMO], zeta))).toEqual([
      'hermetismo',
      'udv',
      'udv/palavra-do-mestre',
      'udv/zeta',
    ]);
    expect(slugs(withTopic([HERMETISMO, UDV], alfa))).toEqual([
      'alfa',
      'hermetismo',
      'udv',
    ]);
  });

  it('replaces a renamed collection and moves it to its new place', () => {
    const renamed = { ...UDV, title: 'Abc' };
    const list = withTopic([HERMETISMO, UDV, PALAVRA], renamed);
    expect(list.map((t) => t.title)).toEqual([
      'Abc',
      'Palavra do Mestre',
      'Hermetismo',
    ]);
  });

  it('keeps the counts the list had for this person when renamed (the answer counts texts alone)', () => {
    const counted = { ...UDV, documentCount: 7, trackCount: 2 };
    const renamed = { ...UDV, title: 'Abc', documentCount: 5, trackCount: 0 };
    const [first] = withTopic([counted, PALAVRA], renamed);
    expect(first).toMatchObject({
      title: 'Abc',
      documentCount: 7,
      trackCount: 2,
    });
  });
});
