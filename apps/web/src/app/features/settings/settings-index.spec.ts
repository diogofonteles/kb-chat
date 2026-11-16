import { UrlSegment } from '@angular/router';
import { aMe, anOwner } from '../../testing/session-fixtures.js';
import {
  SETTINGS_SECTIONS,
  folded,
  mayOpen,
  sectionBySlug,
  slugOf,
} from './settings-index.js';
import { settingsMatcher } from './settings-routes.js';

const segments = (...paths: string[]) =>
  paths.map((path) => new UrlSegment(path, {}));
const match = (...paths: string[]) =>
  settingsMatcher(segments(...paths), {} as never, {} as never);

describe('Configurações addresses (KBC-131 BR-5)', () => {
  it('matches /configuracoes with or without a section, and nothing deeper', () => {
    expect(match('configuracoes')?.posParams).toEqual({});
    expect(
      match('configuracoes', 'preferencias')?.posParams?.['section']?.path,
    ).toBe('preferencias');
    expect(match('configuracoes', 'a', 'b')).toBeNull();
    expect(match('midia')).toBeNull();
  });

  it('gives every section a slug of its own, read back to the same section', () => {
    const slugs = SETTINGS_SECTIONS.map(({ slug }) => slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const { id } of SETTINGS_SECTIONS)
      expect(sectionBySlug(slugOf(id))?.id).toBe(id);
    expect(sectionBySlug('nada')).toBeNull();
  });

  it('finds a section without accents or case', () => {
    expect(folded('Preferências')).toBe('preferencias');
  });
});

describe('who sees which section (BR-4)', () => {
  it('shows a member without own AI only Conta, Preferências, Acessos and Sobre', () => {
    const access = {
      me: aMe({ features: ['search'] }),
      master: false,
      ownAi: false,
    };
    expect(
      SETTINGS_SECTIONS.filter(({ id }) => mayOpen(id, access)).map(
        ({ id }) => id,
      ),
    ).toEqual(['account', 'preferences', 'accesses', 'about']);
  });

  it('shows the media sections to a master only where the media library is on', () => {
    const off = { me: anOwner(), master: true, ownAi: true };
    const on = { me: { ...anOwner(), media: true }, master: true, ownAi: true };
    expect(mayOpen('transcribers', off)).toBe(false);
    expect(mayOpen('transcribers', on)).toBe(true);
    expect(mayOpen('people', on)).toBe(true);
  });
});
