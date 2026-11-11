import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { Author } from '@kb-chat/contracts';
import { SpeakerCombobox } from './speaker-combobox.js';
import type { SpeakerChoice } from './speaker-suggestions.js';

const ANA = {
  id: '00000000-0000-4000-8000-000000000001',
  name: 'Ana',
  authorSlug: null,
  main: false,
};

const MARIANA = { slug: 'mariana-lima', name: 'Mariana Lima', main: true };
const GABRIEL = { slug: 'mestre-gabriel', name: 'Mestre Gabriel', main: false };

async function renderField(
  current = '',
  more: { authors?: readonly Author[]; loading?: boolean } = {},
) {
  const chosen: SpeakerChoice[] = [];
  const result = await render(SpeakerCombobox, {
    inputs: { voice: 2, current, speakers: [ANA], ...more },
    on: { chosen: (choice: SpeakerChoice) => chosen.push(choice) },
    providers: [provideZonelessChangeDetection()],
  });
  const field = screen.getByRole<HTMLInputElement>('combobox', {
    name: 'Quem é a Voz 2?',
  });
  return { ...result, field, chosen };
}

describe('SpeakerCombobox (KBC-065, screens.md T15)', () => {
  it('shows in full a name too long for the field', async () => {
    const longName = 'Maria Aparecida da Conceição dos Santos Oliveira Bezerra';
    await renderField(longName);
    expect(screen.getByText(longName).tagName).toBe('P');
  });

  it('keeps a short name only in the field', async () => {
    await renderField('Ana');
    expect(screen.queryByText('Ana', { selector: 'p' })).toBeNull();
  });

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

  describe('Enter with no option active', () => {
    it.each(['Ana', 'Pergunta da plateia'])(
      'BUG-1: changes nothing on a field that already says %s',
      async (current) => {
        const { fixture, field, chosen } = await renderField(current);
        fireEvent.keyDown(field, { key: 'Enter' });
        await fixture.whenStable();
        expect(chosen).toEqual([]);
        expect(field.value).toBe(current);
        expect(field.getAttribute('aria-invalid')).toBeNull();
      },
    );

    it('BUG-1: leaves a name alone when its text is erased, and shows it again on leaving', async () => {
      const { fixture, field, chosen } = await renderField('Ana');
      fireEvent.input(field, { target: { value: '   ' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      await fixture.whenStable();
      expect(chosen).toEqual([]);
      expect(field.getAttribute('aria-invalid')).toBe('true');
      fireEvent.blur(field);
      await fixture.whenStable();
      expect(field.value).toBe('Ana');
    });

    it('BUG-3: an exact name is that name, not the main author who holds it', async () => {
      const { field, chosen } = await renderField('', { authors: [MARIANA] });
      fireEvent.input(field, { target: { value: ' ANA ' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(chosen).toEqual([{ kind: 'speaker', id: ANA.id }]);
    });

    it('takes an exact author or the audience', async () => {
      const { field, chosen } = await renderField('', { authors: [MARIANA] });
      fireEvent.input(field, { target: { value: 'mariana lima' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      fireEvent.input(field, { target: { value: 'pergunta da plateia' } });
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(chosen).toEqual([
        { kind: 'author', author: MARIANA },
        { kind: 'audience' },
      ]);
    });

    it('I5: part of a name registers nothing: the list opens to choose from', async () => {
      const { fixture, field, chosen } = await renderField('', {
        authors: [GABRIEL],
      });
      fireEvent.input(field, { target: { value: 'Mes' } });
      fireEvent.keyDown(field, { key: 'Escape' });
      fireEvent.keyDown(field, { key: 'Enter' });
      await fixture.whenStable();
      expect(chosen).toEqual([]);
      expect(field.getAttribute('aria-expanded')).toBe('true');
    });

    it('I5: registers that text when the person goes to "Cadastrar"', async () => {
      const { fixture, field, chosen } = await renderField('', {
        authors: [GABRIEL],
      });
      fireEvent.input(field, { target: { value: 'Mes' } });
      fireEvent.keyDown(field, { key: 'ArrowUp' });
      await fixture.whenStable();
      fireEvent.keyDown(field, { key: 'Enter' });
      expect(chosen).toEqual([{ kind: 'new', name: 'Mes' }]);
    });
  });

  describe('while the lists load (T15)', () => {
    it('BUG-6: the list says "Carregando…", which cannot be chosen', async () => {
      const { fixture, field } = await renderField('', { loading: true });
      fireEvent.keyDown(field, { key: 'ArrowDown' });
      await fixture.whenStable();
      const loading = screen.getByRole('option', { name: 'Carregando…' });
      expect(loading.getAttribute('aria-disabled')).toBe('true');
      expect(field.getAttribute('aria-activedescendant')).not.toBe(loading.id);
      fireEvent.keyDown(field, { key: 'ArrowDown' });
      await fixture.whenStable();
      expect(field.getAttribute('aria-activedescendant')).not.toBe(loading.id);
    });

    it('BUG-6: registers nothing: the name may be on the list on its way', async () => {
      const { fixture, field, chosen } = await renderField('', {
        loading: true,
      });
      fireEvent.input(field, { target: { value: 'Mestre Gabriel' } });
      await fixture.whenStable();
      expect(screen.queryByRole('option', { name: /Cadastrar/ })).toBeNull();
      fireEvent.keyDown(field, { key: 'Enter' });
      await fixture.whenStable();
      expect(chosen).toEqual([]);
      expect(field.value).toBe('Mestre Gabriel');
      expect(screen.getByRole('option', { name: 'Carregando…' })).toBeTruthy();
    });
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
