import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { KindsChoice } from './kinds-choice.js';

describe('KindsChoice (KBC-039 FR-5)', () => {
  it('shows the counts, "1000+" at the cap, and toggles a kind', async () => {
    const changed = vi.fn();
    await render(KindsChoice, {
      providers: [provideZonelessChangeDetection()],
      inputs: { kinds: ['text', 'audio'], counts: { text: 3, audio: 1000 } },
      on: { changed },
    });
    expect(
      screen.getByRole('group', { name: 'Buscar em' }).textContent,
    ).toMatch(/Áudios\s*1000\+/);
    fireEvent.click(screen.getByRole('checkbox', { name: /Áudios/ }));
    expect(changed).toHaveBeenCalledWith(['text']);
  });

  it('disables a kind the collection does not have', async () => {
    await render(KindsChoice, {
      providers: [provideZonelessChangeDetection()],
      inputs: { kinds: ['text', 'audio'], counts: { text: 3, audio: null } },
    });
    const audio = screen.getByRole('checkbox', {
      name: /Áudios/,
    }) as HTMLInputElement;
    expect(audio.disabled).toBe(true);
    expect(audio.checked).toBe(false);
  });
});
