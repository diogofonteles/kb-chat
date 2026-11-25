import { provideZonelessChangeDetection } from '@angular/core';
import type { RecordingEntry } from '@kb-chat/contracts';
import { fireEvent, render, screen } from '@testing-library/angular';
import { RecordingChooser, durationText } from './recording-chooser.js';

const entry = (
  n: number,
  durationS: number | null = n * 60,
): RecordingEntry => ({
  url: `https://youtu.be/${n}`,
  title: `Aula ${n}`,
  durationS,
});

async function renderChooser(entries: RecordingEntry[]) {
  const picked = vi.fn();
  const view = await render(RecordingChooser, {
    providers: [provideZonelessChangeDetection()],
    inputs: { entries },
    on: { picked },
  });
  return { ...view, picked };
}

const box = (name: string | RegExp) =>
  screen.getByRole('checkbox', { name }) as HTMLInputElement;

describe('RecordingChooser (KBC-186 R7)', () => {
  it('nothing is chosen before the person says; only what they choose is picked', async () => {
    const { picked, fixture } = await renderChooser([
      entry(1),
      entry(2),
      entry(3),
    ]);
    expect(screen.getByText('Nenhum escolhido')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Incluir' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(box(/Aula 1/));
    fireEvent.click(box(/Aula 3/));
    await fixture.whenStable();
    expect(screen.getByText('2 escolhidos')).toBeTruthy();
    expect(screen.getByText(/· 4:00/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Incluir 2 gravações' }),
    );
    expect(picked).toHaveBeenCalledWith([
      'https://youtu.be/1',
      'https://youtu.be/3',
    ]);
  });

  it('"Selecionar todos" takes all, then none, and is half-marked between', async () => {
    const { fixture } = await renderChooser([entry(1), entry(2)]);
    const all = () => box('Selecionar todos (2)');
    fireEvent.click(all());
    await fixture.whenStable();
    expect(box(/Aula 2/).checked).toBe(true);
    fireEvent.click(box(/Aula 2/));
    await fixture.whenStable();
    expect(all().indeterminate).toBe(true);
    fireEvent.click(all());
    await fixture.whenStable();
    fireEvent.click(all());
    await fixture.whenStable();
    expect(box(/Aula 1/).checked).toBe(false);
  });

  it('a new reading of the same list keeps what was chosen and is still there', async () => {
    const { rerender, fixture } = await renderChooser([entry(1), entry(2)]);
    fireEvent.click(box(/Aula 1/));
    fireEvent.click(box(/Aula 2/));
    await fixture.whenStable();
    await rerender({ inputs: { entries: [entry(2), entry(3)] } });
    expect(box(/Aula 2/).checked).toBe(true);
    expect(box(/Aula 3/).checked).toBe(false);
    expect(screen.getByText('1 escolhido')).toBeTruthy();
  });

  it.each([
    [null, ''],
    [65, '1:05'],
    [3723, '1:02:03'],
    [0, '0:00'],
  ])('%s seconds read "%s"', (seconds, text) => {
    expect(durationText(seconds)).toBe(text);
  });
});
