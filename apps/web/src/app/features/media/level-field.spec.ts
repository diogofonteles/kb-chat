import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import type { LevelChoice } from '@kb-chat/contracts';
import { LevelField } from './level-field.js';

const QS_CI: LevelChoice[] = [
  { id: 'qs', code: 'QS' },
  { id: 'ci', code: 'CI' },
];

async function show(inputs: Record<string, unknown> = {}) {
  const chosen: (string | null)[] = [];
  const view = await render(LevelField, {
    inputs: { choices: QS_CI, label: 'Nível', ...inputs },
    providers: [provideZonelessChangeDetection()],
  });
  view.fixture.componentInstance.level.subscribe((level) => chosen.push(level));
  return { ...view, chosen };
}

const describedBy = (element: HTMLElement): string =>
  (element.getAttribute('aria-describedby') ?? '')
    .split(' ')
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
    .join(' ');

describe('LevelField (KBC-105, T14)', () => {
  it('AC-2: offers the levels it was given as radios, none chosen beforehand (SL-28)', async () => {
    const { chosen } = await show();

    const group = screen.getByRole('group', { name: 'Nível' });
    expect(describedBy(group)).toBe(
      'Quem tem este nível ou um acima poderá ouvir.',
    );
    const radios = screen.getAllByRole<HTMLInputElement>('radio');
    expect(radios.map((one) => one.labels?.[0]?.textContent?.trim())).toEqual([
      'QS',
      'CI',
    ]);
    expect(radios.some((one) => one.checked)).toBe(false);
    fireEvent.click(screen.getByRole('radio', { name: 'CI' }));
    expect(chosen).toEqual(['ci']);
  });

  it('AC-1: says what is missing next to the field once the person tried to send', async () => {
    await show({ invalid: true });

    expect(screen.getByRole('alert').textContent).toContain(
      'Escolha o nível deste áudio.',
    );
    const group = screen.getByRole('group', { name: 'Nível' });
    // ARIA 1.2: aria-invalid belongs to the radiogroup, neither the group nor a radio.
    expect(group.hasAttribute('aria-invalid')).toBe(false);
    const radios = screen.getByRole('radiogroup', { name: 'Nível' });
    expect(radios.getAttribute('aria-invalid')).toBe('true');
    expect(
      screen
        .getAllByRole('radio')
        .some((one) => one.hasAttribute('aria-invalid')),
    ).toBe(false);
    expect(describedBy(group)).toContain('Escolha o nível deste áudio.');
  });

  it('turns into a select past six levels, with "Escolha um nível" first', async () => {
    const many = Array.from({ length: 7 }, (_, n) => ({
      id: `l${n}`,
      code: `L${n}`,
    }));
    const { chosen } = await show({ choices: many, label: 'Nível em UDV' });

    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Nível em UDV',
    });
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe(
      'Escolha um nível',
    );
    fireEvent.change(select, { target: { value: 'l3' } });
    fireEvent.change(select, { target: { value: '' } });
    expect(chosen).toEqual(['l3', null]);
  });

  it('says while the levels load, and when they could not be had', async () => {
    const { rerender, fixture } = await show({ loading: true });
    expect(screen.getByText('Carregando níveis…')).toBeTruthy();
    expect(screen.queryAllByRole('radio')).toEqual([]);

    await rerender({
      componentInputs: { loading: false, failed: true },
      partialUpdate: true,
    });
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui carregar os níveis deste acervo. Carregue de novo para escolher o nível.',
    );
    const retried = vi.fn();
    fixture.componentInstance.retried.subscribe(retried);
    const button = screen.getByRole('button', {
      name: 'Carregar níveis de novo',
    });
    button.focus();
    fireEvent.click(button);
    expect(retried).toHaveBeenCalledOnce();

    // Review round 2: while it asks again the same button stays, busy, with the focus.
    await rerender({
      componentInputs: { failed: false, retrying: true, loading: true },
      partialUpdate: true,
    });
    const busy = screen.getByRole('button', { name: 'Carregando níveis…' });
    expect(busy).toBe(button);
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(document.activeElement).toBe(busy);
    fireEvent.click(busy);
    expect(retried).toHaveBeenCalledOnce();

    // The levels came: the focus goes on to the choices (MA-29), not to the body.
    await rerender({
      componentInputs: { retrying: false, loading: false },
      partialUpdate: true,
    });
    await fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByRole('radio', { name: 'QS' }),
    );
  });
});
