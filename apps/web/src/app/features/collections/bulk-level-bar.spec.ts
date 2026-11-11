import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { BulkLevelBar } from './bulk-level-bar.js';

async function open(count = 3) {
  const applied = vi.fn();
  const rendered = await render(BulkLevelBar, {
    providers: [provideZonelessChangeDetection()],
    inputs: {
      count,
      choices: [
        { id: 'qs', code: 'QS' },
        { id: 'ci', code: 'CI' },
      ],
    },
    on: { applied },
  });
  return { ...rendered, applied };
}

describe('The bulk level bar (KBC-107, MA-27, SL-28)', () => {
  it('chooses no level in advance and asks before giving one', async () => {
    const { fixture, applied } = await open();
    const give = screen.getByRole('button', { name: 'Dar nível' });
    expect(give).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByRole('combobox', { name: 'Nível' }), {
      target: { value: 'ci' },
    });
    await fixture.whenStable();
    fireEvent.click(give);
    await fixture.whenStable();
    expect(screen.getByText('Dar o nível CI a 3 documentos?')).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Confirmar' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    fireEvent.click(
      screen.queryByRole('button', { name: 'Confirmar' }) ?? document.body,
    );
    expect(applied).toHaveBeenCalledTimes(1);
    expect(applied).toHaveBeenCalledWith({ id: 'ci', code: 'CI' });
  });

  it('cancels back to the button, without giving anything', async () => {
    const { fixture, applied } = await open(1);
    fireEvent.change(screen.getByRole('combobox', { name: 'Nível' }), {
      target: { value: 'qs' },
    });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Dar nível' }));
    await fixture.whenStable();
    expect(screen.getByText('Dar o nível QS a 1 documento?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Dar nível' }),
    );
    expect(applied).not.toHaveBeenCalled();
  });

  it('cannot give a level to nothing', async () => {
    await open(0);
    expect(screen.getByText('0 selecionados')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dar nível' })).toHaveProperty(
      'disabled',
      true,
    );
  });

  it('R1-4: a confirmation whose selection emptied under it is gone', async () => {
    const { fixture, applied } = await open(2);
    fireEvent.change(screen.getByRole('combobox', { name: 'Nível' }), {
      target: { value: 'qs' },
    });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Dar nível' }));
    await fixture.whenStable();
    expect(screen.getByRole('button', { name: 'Confirmar' })).toBeTruthy();
    fixture.componentRef.setInput('count', 0);
    await fixture.whenStable();
    expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
    expect(applied).not.toHaveBeenCalled();
  });

  it('QA-r2-1: a confirmation left open never comes back when the selection empties and fills again, nor when the levels change', async () => {
    const { fixture, applied } = await open(8);
    const choose = (id: string) =>
      fireEvent.change(screen.getByRole('combobox', { name: 'Nível' }), {
        target: { value: id },
      });
    choose('qs');
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Dar nível' }));
    await fixture.whenStable();
    expect(screen.getByText('Dar o nível QS a 8 documentos?')).toBeTruthy();
    fixture.componentRef.setInput('count', 0);
    await fixture.whenStable();
    fixture.componentRef.setInput('count', 8);
    await fixture.whenStable();
    expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
    expect(screen.getByRole('combobox', { name: 'Nível' })).toBeTruthy();

    choose('ci');
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Dar nível' }));
    await fixture.whenStable();
    fixture.componentRef.setInput('choices', [{ id: 'qs', code: 'QS' }]);
    await fixture.whenStable();
    expect(screen.queryByRole('button', { name: 'Confirmar' })).toBeNull();
    expect(screen.queryByText(/Dar o nível {2}a/)).toBeNull();
    expect(applied).not.toHaveBeenCalled();
  });
});
