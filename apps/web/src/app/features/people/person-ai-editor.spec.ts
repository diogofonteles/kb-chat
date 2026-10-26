import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { DEFAULT_PERSON_AI, type PersonAi } from '@kb-chat/contracts';
import { PersonAiEditor } from './person-ai-editor.js';

async function renderEditor(ai: PersonAi = DEFAULT_PERSON_AI) {
  const changed = vi.fn();
  const view = await render(PersonAiEditor, {
    providers: [provideZonelessChangeDetection()],
    inputs: { ai, defaultAppAi: 'house' },
    on: { changed },
  });
  return { ...view, changed };
}

describe('PersonAiEditor (KBC-022 FR-5)', () => {
  it('names the default and sends each change up', async () => {
    const { changed } = await renderEditor();
    const select = screen.getByLabelText('Qual IA atende esta pessoa');
    expect(select.textContent).toContain('Padrão: Plano da casa');
    fireEvent.change(select, { target: { value: 'none' } });
    expect(changed).toHaveBeenLastCalledWith({ appAi: 'none' });
    fireEvent.click(screen.getByRole('checkbox', { name: /Usar sempre/ }));
    expect(changed).toHaveBeenLastCalledWith({ enforced: true });
    const daily = screen.getByLabelText('Pesquisas por dia (vazio = padrão)');
    fireEvent.change(daily, { target: { value: '3' } });
    expect(changed).toHaveBeenLastCalledWith({ dailyResearches: 3 });
    fireEvent.change(daily, { target: { value: '' } });
    expect(changed).toHaveBeenLastCalledWith({ dailyResearches: null });
    fireEvent.click(screen.getByRole('checkbox', { name: /modelo pago/ }));
    expect(changed).toHaveBeenLastCalledWith({
      paidFallback: { enabled: true, monthlyCapUsd: 1 },
    });
  });

  it('edits the monthly cap and lists the history newest first', async () => {
    const { changed } = await renderEditor({
      ...DEFAULT_PERSON_AI,
      paidFallback: { enabled: true, monthlyCapUsd: 2 },
      history: [
        {
          appAi: 'house',
          enforced: false,
          by: 'a@x.com',
          at: '2026-10-26T10:00:00.000Z',
        },
        {
          appAi: 'none',
          enforced: true,
          by: 'b@x.com',
          at: '2026-10-26T11:00:00.000Z',
        },
      ],
    });
    fireEvent.change(screen.getByLabelText('Teto por mês (US$)'), {
      target: { value: '5' },
    });
    expect(changed).toHaveBeenLastCalledWith({
      paidFallback: { enabled: true, monthlyCapUsd: 5 },
    });
    const items = screen
      .getAllByRole('listitem')
      .map((li) => li.textContent ?? '');
    expect(items[0]).toContain('b@x.com');
    expect(items[0]).toContain('(sempre)');
    expect(items[1]).toContain('Plano da casa');
  });
});
