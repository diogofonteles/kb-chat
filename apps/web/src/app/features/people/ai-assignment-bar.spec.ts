import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { AiAssignmentBar } from './ai-assignment-bar.js';

describe('AiAssignmentBar (KBC-022 AC-12)', () => {
  it('applies to the selection, or to everyone and the future default', async () => {
    const apply = vi.fn();
    const { fixture } = await render(AiAssignmentBar, {
      providers: [provideZonelessChangeDetection()],
      inputs: { selectedCount: 2, total: 3, defaultAppAi: 'house' },
      on: { apply },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Aplicar às selecionadas (2)' }),
    );
    expect(apply).toHaveBeenLastCalledWith({
      target: 'selected',
      appAi: 'house',
      setDefault: false,
    });
    fireEvent.change(screen.getByLabelText('IA'), {
      target: { value: 'none' },
    });
    fireEvent.click(
      screen.getByRole('checkbox', { name: /próximos convidados/ }),
    );
    await fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: 'Aplicar a todos os usuários' }),
    );
    await fixture.whenStable();
    expect(screen.getByRole('alert').textContent).toContain(
      'a todas as 3 pessoas',
    );
    expect(apply).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Aplicar a todos' }));
    expect(apply).toHaveBeenLastCalledWith({
      target: 'all',
      appAi: 'none',
      setDefault: true,
    });
    fireEvent.change(screen.getByLabelText('IA'), {
      target: { value: 'default' },
    });
    await fixture.whenStable();
    expect(
      (
        screen.getByRole('checkbox', {
          name: /próximos convidados/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });
});
