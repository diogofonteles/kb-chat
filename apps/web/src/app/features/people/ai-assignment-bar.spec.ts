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
    // Focus follows the confirmation, and goes back on "Cancelar".
    expect(document.activeElement?.textContent?.trim()).toBe('Cancelar');
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(document.activeElement?.textContent?.trim()).toBe(
      'Aplicar a todos os usuários',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Aplicar a todos os usuários' }),
    );
    await fixture.whenStable();
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

  it('KBC-024: confirms the terms before lending the subscription, never as the default', async () => {
    const apply = vi.fn();
    const { fixture } = await render(AiAssignmentBar, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        selectedCount: 1,
        total: 3,
        defaultAppAi: 'house',
        lending: { canLend: true, available: true },
      },
      on: { apply },
    });
    fireEvent.change(screen.getByLabelText('IA'), {
      target: { value: 'claude-subscription' },
    });
    await fixture.whenStable();
    expect(
      (
        screen.getByRole('checkbox', {
          name: /próximos convidados/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Aplicar às selecionadas (1)' }),
    );
    await fixture.whenStable();
    expect(apply).not.toHaveBeenCalled();
    // The scope comes first, then the terms (design D2); focus on the safe choice (D5).
    const confirm = screen.getByRole('group', {
      name: 'Ceder a assinatura do Claude a 1 pessoa selecionada?',
    });
    expect(confirm.textContent).toContain(
      'Os termos da Anthropic não permitem',
    );
    expect(document.activeElement?.textContent?.trim()).toBe('Cancelar');
    expect(
      screen.getByText(
        'A assinatura não pode valer para os próximos convidados.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ceder assim mesmo' }));
    expect(apply).toHaveBeenLastCalledWith({
      target: 'selected',
      appAi: 'claude-subscription',
      setDefault: false,
      subscriptionTermsAccepted: true,
    });
  });

  it('KBC-024 QA BUG-2: choosing another AI closes the terms', async () => {
    const apply = vi.fn();
    const { fixture } = await render(AiAssignmentBar, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        selectedCount: 2,
        total: 3,
        defaultAppAi: 'house',
        lending: { canLend: true, available: true },
      },
      on: { apply },
    });
    fireEvent.change(screen.getByLabelText('IA'), {
      target: { value: 'claude-subscription' },
    });
    await fixture.whenStable();
    fireEvent.click(
      screen.getByRole('button', { name: 'Aplicar a todos os usuários' }),
    );
    await fixture.whenStable();
    expect(
      screen.getByRole('group', {
        name: 'Ceder a assinatura do Claude a todas as 3 pessoas?',
      }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('IA'), {
      target: { value: 'house' },
    });
    await fixture.whenStable();
    expect(
      screen.queryByRole('button', { name: 'Ceder assim mesmo' }),
    ).toBeNull();
    expect(apply).not.toHaveBeenCalled();
  });

  it('KBC-024 QA R2-4: never lends to an empty selection, and one confirmation at a time', async () => {
    const apply = vi.fn();
    const { fixture } = await render(AiAssignmentBar, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        selectedCount: 1,
        total: 3,
        defaultAppAi: 'house',
        lending: { canLend: true, available: true },
      },
      on: { apply },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Aplicar a todos os usuários' }),
    );
    await fixture.whenStable();
    fireEvent.change(screen.getByLabelText('IA'), {
      target: { value: 'claude-subscription' },
    });
    await fixture.whenStable();
    expect(
      screen.queryByRole('button', { name: 'Aplicar a todos' }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Aplicar às selecionadas (1)' }),
    );
    await fixture.whenStable();
    fixture.componentRef.setInput('selectedCount', 0);
    await fixture.whenStable();
    expect(
      (
        screen.getByRole('button', {
          name: 'Ceder assim mesmo',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
