import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import { TOPICS } from '../../testing/fixtures.js';
import { PeopleLevelBar } from './people-level-bar.js';

const SCALES = [
  {
    collection: 'hermetismo',
    levels: [
      { id: 'qs', code: 'QS' },
      { id: 'ci', code: 'CI' },
    ],
  },
  { collection: 'alquimia', levels: [{ id: 'a1', code: 'A1' }] },
];

async function renderBar(selectedCount = 3) {
  const apply = vi.fn();
  const view = await render(PeopleLevelBar, {
    providers: [provideZonelessChangeDetection()],
    inputs: { scales: SCALES, topics: TOPICS.items, selectedCount },
    on: { apply },
  });
  return { ...view, apply };
}

const applyButton = () =>
  screen.getByRole<HTMLButtonElement>('button', {
    name: /Aplicar nível às selecionadas/,
  });

describe('PeopleLevelBar (T9, KBC-109 FR-5)', () => {
  it('applies the level chosen in the collection chosen to the selection', async () => {
    const { apply, fixture } = await renderBar();
    const bar = screen.getByRole('group', {
      name: 'Nível para várias pessoas',
    });
    expect(
      within(bar).getByRole<HTMLSelectElement>('combobox', { name: 'Nível em' })
        .value,
    ).toBe('hermetismo');
    // No level in advance (SL-28): nothing to apply yet.
    expect(applyButton().disabled).toBe(true);
    fireEvent.change(within(bar).getByRole('combobox', { name: 'Nível' }), {
      target: { value: 'ci' },
    });
    await fixture.whenStable();
    fireEvent.click(applyButton());
    expect(apply).toHaveBeenCalledWith({
      collection: 'hermetismo',
      level: 'ci',
    });
  });

  it('another collection shows its own levels and asks for the level again', async () => {
    const { fixture } = await renderBar();
    const level = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Nível',
    });
    fireEvent.change(level, { target: { value: 'ci' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Nível em' }), {
      target: { value: 'alquimia' },
    });
    await fixture.whenStable();
    const codes = within(level)
      .getAllByRole('option')
      .map((option) => option.textContent?.trim());
    expect(codes).toEqual(['Escolha', 'A1']);
    expect(applyButton().disabled).toBe(true);
  });

  it('waits for a selection', async () => {
    const { fixture } = await renderBar(0);
    fireEvent.change(screen.getByRole('combobox', { name: 'Nível' }), {
      target: { value: 'ci' },
    });
    await fixture.whenStable();
    expect(applyButton().disabled).toBe(true);
  });
});
