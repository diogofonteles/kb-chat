import { provideZonelessChangeDetection } from '@angular/core';
import { DEFAULT_PERSON_AI, type Person } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { TOPICS, aTopic } from '../../testing/fixtures.js';
import { PersonEditor } from './person-editor.js';

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
      topics: [
        ...TOPICS.items,
        aTopic({
          slug: 'hermetismo/aulas',
          title: 'Aulas',
          parent: 'hermetismo',
        }),
      ],
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
