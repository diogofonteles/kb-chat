import { aTopic } from '../../testing/fixtures.js';
import {
  collectionChoices,
  defaultTopicOf,
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

describe('the collection that opens when none is chosen (chat and wizard, KBC-028)', () => {
  const list = (
    items: Parameters<typeof aTopic>[0][],
    defaultSlug = null as string | null,
  ) => ({
    items: items.map(aTopic),
    defaultSlug,
  });

  it("is the server's default when it gives one", () => {
    expect(
      defaultTopicOf(
        list(
          [
            { slug: 'hermetismo', title: 'Hermetismo', documentCount: 9 },
            { slug: 'udv', title: 'UDV', documentCount: 1 },
          ],
          'udv',
        ),
      ),
    ).toBe('udv');
  });

  it('else the one with most documents that opens, the first listed on a tie', () => {
    expect(
      defaultTopicOf(
        list([
          { slug: 'udv', title: 'UDV', documentCount: 50, canOpen: false },
          { slug: 'alquimia', title: 'Alquimia', documentCount: 7 },
          { slug: 'hermetismo', title: 'Hermetismo', documentCount: 7 },
        ]),
      ),
    ).toBe('alquimia');
  });

  it('is none without a list or a collection that opens', () => {
    expect(defaultTopicOf(null)).toBeNull();
    expect(
      defaultTopicOf(list([{ slug: 'udv', title: 'UDV', canOpen: false }])),
    ).toBeNull();
  });
});
