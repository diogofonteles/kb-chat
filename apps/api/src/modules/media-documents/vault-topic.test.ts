import { describe, expect, it } from 'vitest';
import type { TopicFolder } from '../../ports/vault-reader.js';
import { collectionOf, domainOfTopic, toDomain } from './vault-topic.js';

const VAULT: readonly TopicFolder[] = [
  { slug: 'hermetismo', title: 'Hermetismo', domain: 'esoterismo' },
  { slug: 'udv', title: 'UDV', domain: 'espiritualidade' },
  {
    slug: 'udv/palavra-do-mestre',
    title: 'Palavra do Mestre',
    domain: 'espiritualidade',
    parent: 'udv',
  },
];

describe('the domain of a new vault topic (KBC-114 BR-4)', () => {
  it("keeps a vault topic's own domain", () => {
    expect(domainOfTopic(VAULT, 'hermetismo')).toBe('esoterismo');
  });

  it("gives a sub-collection made on the screen its parent's domain", () => {
    const topics = [
      ...VAULT,
      { slug: 'udv/hinos', title: 'Hinos', parent: 'udv', screenOnly: true },
    ] as const;
    expect(domainOfTopic(topics, 'udv/hinos')).toBe('espiritualidade');
  });

  it("gives a new collection the vault's most used domain, a tie by alphabetical order", () => {
    const topics = [
      ...VAULT,
      { slug: 'nova', title: 'Nova', screenOnly: true },
    ] as const;
    expect(domainOfTopic(topics, 'nova')).toBe('espiritualidade');
    const tie = [
      { slug: 'b', title: 'B', domain: 'zen' },
      { slug: 'a', title: 'A', domain: 'alquimia' },
      { slug: 'nova', title: 'Nova', screenOnly: true as const },
    ];
    expect(domainOfTopic(tie, 'nova')).toBe('alquimia');
  });

  it('falls back to geral in an empty vault', () => {
    expect(
      domainOfTopic([{ slug: 'nova', title: 'Nova', screenOnly: true }], 'nova'),
    ).toBe('geral');
  });

  it.each([
    ['Esoterismo Geral', 'esoterismo-geral'],
    ['Espiritualidade', 'espiritualidade'],
    ['ação', 'acao'],
    ['../x', 'x'],
    ['***', null],
    [undefined, null],
  ])('turns %s into one word kb takes: %s', (value, word) => {
    expect(toDomain(value)).toBe(word);
  });
});

describe('what a kb-publish job tells the Mac about its collection (KBC-114 FR-2)', () => {
  it('a top-level collection has no parent', () => {
    expect(collectionOf(VAULT, 'hermetismo')).toEqual({
      title: 'Hermetismo',
      domain: 'esoterismo',
      parent: null,
    });
  });

  it('a sub-collection carries its parent, created first when the vault lacks it', () => {
    const topics = [
      { slug: 'nova', title: 'Nova', screenOnly: true as const },
      {
        slug: 'nova/parte',
        title: 'Parte',
        parent: 'nova',
        screenOnly: true as const,
      },
    ];
    expect(collectionOf(topics, 'nova/parte')).toEqual({
      title: 'Parte',
      domain: 'geral',
      parent: { slug: 'nova', title: 'Nova', domain: 'geral' },
    });
  });

  it('a collection the app does not know has none', () => {
    expect(collectionOf(VAULT, 'sumiu')).toBeNull();
  });

  it('cuts a vault title longer than a screen title may be', () => {
    const long = [{ slug: 'x', title: 'a'.repeat(200), domain: 'geral' }];
    expect(collectionOf(long, 'x')?.title).toHaveLength(80);
  });
});
