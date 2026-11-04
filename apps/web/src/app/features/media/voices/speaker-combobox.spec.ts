import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { SpeakerCombobox } from './speaker-combobox.js';
import type { SpeakerChoice } from './speaker-suggestions.js';

const ANA = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Ana',
  authorSlug: null,
  main: false,
};

async function renderField(current = '') {
  const chosen: SpeakerChoice[] = [];
  const result = await render(SpeakerCombobox, {
    inputs: { voice: 2, current, speakers: [ANA] },
    on: { chosen: (choice: SpeakerChoice) => chosen.push(choice) },
    providers: [provideZonelessChangeDetection()],
  });
  const field = screen.getByRole<HTMLInputElement>('combobox', {
    name: 'Quem é a Voz 2?',
  });
  return { ...result, field, chosen };
}

describe('SpeakerCombobox (KBC-065, screens.md T15)', () => {
  it('opens with ↓, walks the list and chooses with Enter, only by keyboard (AC-8)', async () => {
    const { fixture, field, chosen } = await renderField();
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    await fixture.whenStable();
    expect(field.getAttribute('aria-expanded')).toBe('true');
    const options = screen.getAllByRole('option');
    expect(options.map((one) => one.textContent?.trim())).toEqual([
      'Pergunta da plateia',
      'Ana',
    ]);
    expect(options[1]?.getAttribute('aria-selected')).toBe('true');
    expect(field.getAttribute('aria-activedescendant')).toBe(options[1]?.id);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(chosen).toEqual([{ kind: 'speaker', id: ANA.id }]);
    await fixture.whenStable();
    expect(field.getAttribute('aria-expanded')).toBe('false');
  });

  it('Escape closes the list and goes no further', async () => {
    const { fixture, field } = await renderField();
    fireEvent.keyDown(field, { key: 'ArrowDown' });
    await fixture.whenStable();
    const outer = vi.fn();
    document.addEventListener('keydown', outer);
    fireEvent.keyDown(field, { key: 'Escape' });
    document.removeEventListener('keydown', outer);
    await fixture.whenStable();
    expect(outer).not.toHaveBeenCalled();
    expect(field.getAttribute('aria-expanded')).toBe('false');
  });

  it('registers a typed name with Enter', async () => {
    const { field, chosen } = await renderField();
    fireEvent.input(field, { target: { value: ' Maria ' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(chosen).toEqual([{ kind: 'new', name: 'Maria' }]);
  });

  it('takes the option pressed with the pointer', async () => {
    const { fixture, field, chosen } = await renderField();
    fireEvent.click(field);
    await fixture.whenStable();
    fireEvent.mouseDown(
      screen.getByRole('option', { name: 'Pergunta da plateia' }),
    );
    expect(chosen).toEqual([{ kind: 'audience' }]);
  });

  it('AC-7: says a blank or too long name at the field and chooses nothing', async () => {
    const { fixture, field, chosen } = await renderField();
    fireEvent.keyDown(field, { key: 'Enter' });
    await fixture.whenStable();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.body.textContent).toContain(
      'O nome deve ter de 1 a 120 caracteres',
    );
    fireEvent.input(field, { target: { value: 'a'.repeat(121) } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await fixture.whenStable();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(chosen).toEqual([]);
  });

  it('goes back to what the voice is on leaving without choosing', async () => {
    const { fixture, field, chosen } = await renderField('Ana');
    expect(field.value).toBe('Ana');
    fireEvent.input(field, { target: { value: 'Ma' } });
    fireEvent.blur(field);
    await fixture.whenStable();
    expect(field.value).toBe('Ana');
    expect(chosen).toEqual([]);
  });

  it('offers "Sem nome" for a named voice', async () => {
    const { fixture, field, chosen } = await renderField('Ana');
    fireEvent.click(field);
    await fixture.whenStable();
    fireEvent.mouseDown(screen.getByRole('option', { name: 'Sem nome' }));
    expect(chosen).toEqual([{ kind: 'none' }]);
  });
});
