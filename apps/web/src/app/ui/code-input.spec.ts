import { provideZonelessChangeDetection, signal } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { UiCodeInput } from './code-input.js';

async function renderCode() {
  const value = signal('');
  const result = await render(
    `<span id="label">Código</span>
     <ui-code-input labelledBy="label" [(value)]="value" />`,
    {
      imports: [UiCodeInput],
      componentProperties: { value },
      providers: [provideZonelessChangeDetection()],
    },
  );
  const box = (n: number) =>
    screen.getByLabelText(`Dígito ${n} de 6`) as HTMLInputElement;
  return { ...result, value, box };
}

describe('UiCodeInput (KBC-124 FR-4, AC-4)', () => {
  it('is a group named by its label, with one box per digit', async () => {
    await renderCode();
    expect(screen.getByRole('group', { name: 'Código' })).toBeTruthy();
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
  });

  it('fills every box from a pasted code, spaces and all', async () => {
    const { value, box, fixture } = await renderCode();
    fireEvent.paste(box(1), {
      clipboardData: { getData: () => '481 920' },
    });
    await fixture.whenStable();
    expect(value()).toBe('481920');
    expect([1, 2, 3, 4, 5, 6].map((n) => box(n).value).join('')).toBe('481920');
  });

  it('moves to the next box as digits are typed and ignores letters', async () => {
    const { value, box, fixture } = await renderCode();
    fireEvent.input(box(1), { target: { value: '4' } });
    await fixture.whenStable();
    expect(document.activeElement).toBe(box(2));
    fireEvent.input(box(2), { target: { value: 'a' } });
    await fixture.whenStable();
    expect(value()).toBe('4');
    expect(box(2).value).toBe('');
  });

  it('goes back to the box before on Backspace in an empty box', async () => {
    const { value, box, fixture } = await renderCode();
    fireEvent.input(box(1), { target: { value: '48' } });
    await fixture.whenStable();
    expect(document.activeElement).toBe(box(3));
    fireEvent.keyDown(box(3), { key: 'Backspace' });
    await fixture.whenStable();
    expect(value()).toBe('4');
    expect(document.activeElement).toBe(box(2));
  });
});
