import { provideZonelessChangeDetection } from '@angular/core';
import { DEFAULT_PERSON_AI, type Person } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { TOPICS, aTopic } from '../../testing/fixtures.js';
import { PersonEditor } from './person-editor.js';
import { plainPreset } from './preset-defaults.js';

const ana = (overrides: Partial<Person> = {}): Person => ({
  id: '11111111-1111-4111-8111-111111111111',
  email: 'ana@example.com',
  name: 'Ana',
  picture: null,
  role: 'member',
  topics: ['hermetismo'],
  features: ['search'],
  isOwner: false,
  canActAs: false,
  phone: null,
  invitation: null,
  invitedBy: 'owner@example.com',
  createdAt: '2026-10-24T10:00:00.000Z',
  lastLoginAt: null,
  levels: {},
  ai: DEFAULT_PERSON_AI,
  ...overrides,
});

const SCALES = [
  {
    collection: 'hermetismo',
    levels: [
      { id: 'qs', code: 'QS' },
      { id: 'ci', code: 'CI' },
      { id: 'cdc', code: 'CDC' },
    ],
  },
  { collection: 'alquimia', levels: [{ id: 'a1', code: 'A1' }] },
];

async function renderEditor(person: Person) {
  const changed = vi.fn();
  await render(PersonEditor, {
    providers: [provideZonelessChangeDetection()],
    inputs: {
      person,
      // In the server's tree order: a sub-collection right after its parent.
      topics: TOPICS.items.flatMap((topic) =>
        topic.slug === 'hermetismo'
          ? [
              topic,
              aTopic({
                slug: 'hermetismo/aulas',
                title: 'Aulas',
                parent: 'hermetismo',
              }),
            ]
          : [topic],
      ),
      scales: SCALES,
    },
    on: { changed },
  });
  return { changed };
}

describe('PersonEditor: "Nível em <acervo>" (T9, KBC-103 FR-3)', () => {
  it('BR-5: offers the levels of each collection with levels she reaches, the lowest by default', async () => {
    const { changed } = await renderEditor(ana());
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Nível em Hermetismo',
    });
    expect(select.value).toBe('qs');
    expect(
      screen.queryByRole('combobox', { name: 'Nível em Alquimia' }),
    ).toBeNull();
    fireEvent.change(select, { target: { value: 'ci' } });
    expect(changed).toHaveBeenCalledWith({ levels: { hermetismo: 'ci' } });
  });

  it('shows her level, also when she reaches the collection through a sub-collection', async () => {
    await renderEditor(
      ana({ topics: ['hermetismo/aulas'], levels: { hermetismo: 'cdc' } }),
    );
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Nível em Hermetismo',
    });
    expect(select.value).toBe('cdc');
  });

  it('a master sees every level: no select', async () => {
    await renderEditor(ana({ role: 'master' }));
    expect(screen.getByText('Masters veem todos os níveis.')).toBeTruthy();
    expect(screen.queryByRole('combobox', { name: /Nível em/ })).toBeNull();
  });
});

describe('PersonEditor: "Classificar nível de conteúdo" (T9, KBC-107 FR-3)', () => {
  it('lists the feature by its name, off until granted', async () => {
    await renderEditor(ana());
    const box = screen.getByRole('checkbox', {
      name: 'Classificar nível de conteúdo',
    });
    expect(box).toHaveProperty('checked', false);
  });
});

describe('PersonEditor: the level right under its collection (T9, KBC-109 AC-7)', () => {
  it('places "Nível em Hermetismo" after Hermetismo and its sub-collection, before Alquimia', async () => {
    await renderEditor(ana());
    const group = screen.getByRole('group', { name: 'Acervos' });
    const select = screen.getByRole('combobox', {
      name: 'Nível em Hermetismo',
    });
    expect(group.contains(select)).toBe(true);
    const aulas = screen.getByRole('checkbox', { name: /Aulas/ });
    const alquimia = screen.getByRole('checkbox', { name: 'Alquimia' });
    const follows = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(aulas.compareDocumentPosition(select) & follows).toBeTruthy();
    expect(select.compareDocumentPosition(alquimia) & follows).toBeTruthy();
  });
});

describe('PersonEditor: applying a profile whose level no longer exists (KBC-109 BR-3)', () => {
  it('says the person goes to the lowest level there, before applying', async () => {
    await render(PersonEditor, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        person: ana(),
        topics: TOPICS.items,
        scales: SCALES,
        profiles: [
          {
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Aluno',
            isDefault: false,
            preset: {
              ...plainPreset(),
              topics: ['hermetismo'],
              levels: { hermetismo: 'velho' },
            },
            staleLevels: { hermetismo: 'velho' },
          },
        ],
      },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar perfil' }));
    const warning = screen.getByText(
      /Em Hermetismo, o nível velho não existe mais; quem tiver este perfil aplicado fica no nível mais baixo\./,
    );
    // The focus goes to "Aplicar": the warning is read there (R2-7).
    expect(
      screen
        .getByRole('button', { name: 'Aplicar' })
        .getAttribute('aria-describedby'),
    ).toBe(warning.id);
  });
});
