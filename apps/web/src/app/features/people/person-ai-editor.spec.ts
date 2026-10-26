import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { DEFAULT_PERSON_AI, type PersonAi } from '@kb-chat/contracts';
import { PersonAiEditor } from './person-ai-editor.js';
import { LEND_ALL, LEND_NONE } from '../../testing/lending-fixtures.js';

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

  it('says why an invalid number is not saved, on its field (QA defect 2)', async () => {
    const { changed, fixture } = await renderEditor({
      ...DEFAULT_PERSON_AI,
      paidFallback: { enabled: true, monthlyCapUsd: 2 },
    });
    const daily = screen.getByLabelText('Pesquisas por dia (vazio = padrão)');
    fireEvent.change(daily, { target: { value: '-1' } });
    await fixture.whenStable();
    expect(changed).not.toHaveBeenCalled();
    expect(daily.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain(
      'número inteiro de 0 a 500',
    );
    fireEvent.change(screen.getByLabelText('Teto por mês (US$)'), {
      target: { value: '150' },
    });
    await fixture.whenStable();
    expect(changed).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('de 0 a 100 (US$)');
  });

  it('says why an invalid number is not saved, on its field (QA defect 2)', async () => {
    const { changed, fixture } = await renderEditor({
      ...DEFAULT_PERSON_AI,
      paidFallback: { enabled: true, monthlyCapUsd: 2 },
    });
    const daily = screen.getByLabelText('Pesquisas por dia (vazio = padrão)');
    fireEvent.change(daily, { target: { value: '-1' } });
    await fixture.whenStable();
    expect(changed).not.toHaveBeenCalled();
    expect(daily.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain(
      'número inteiro de 0 a 500',
    );
    fireEvent.change(screen.getByLabelText('Teto por mês (US$)'), {
      target: { value: '150' },
    });
    await fixture.whenStable();
    expect(changed).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('de 0 a 100 (US$)');
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

  it('KBC-024: lends the owner’s subscription only after the terms are confirmed', async () => {
    const changed = vi.fn();
    const { fixture } = await render(PersonAiEditor, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        ai: DEFAULT_PERSON_AI,
        defaultAppAi: 'house',
        lending: { canLend: true, lendable: LEND_ALL },
      },
      on: { changed },
    });
    const select = screen.getByLabelText('Qual IA atende esta pessoa');
    fireEvent.change(select, { target: { value: 'claude-subscription' } });
    await fixture.whenStable();
    expect(changed).not.toHaveBeenCalled();
    const confirm = screen.getByRole('group', {
      name: 'Ceder a assinatura do Claude a esta pessoa?',
    });
    expect(confirm.textContent).toContain(
      'Os termos da Anthropic não permitem',
    );
    // Focus starts on the safe choice (design D5).
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Cancelar' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(changed).not.toHaveBeenCalled();
    expect((select as HTMLSelectElement).value).toBe('default');
    fireEvent.change(select, { target: { value: 'claude-subscription' } });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Ceder assim mesmo' }));
    expect(changed).toHaveBeenLastCalledWith({
      appAi: 'claude-subscription',
      subscriptionTermsAccepted: true,
    });
    await fixture.whenStable();
    // Focus goes back to the choice it came from (design D1).
    expect(document.activeElement).toBe(select);
  });

  it('KBC-024 QA BUG-1: choosing another AI or changing another field closes the terms', async () => {
    const changed = vi.fn();
    const { fixture } = await render(PersonAiEditor, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        ai: DEFAULT_PERSON_AI,
        defaultAppAi: 'house',
        lending: { canLend: true, lendable: LEND_ALL },
      },
      on: { changed },
    });
    const select = screen.getByLabelText('Qual IA atende esta pessoa');
    fireEvent.change(select, { target: { value: 'claude-subscription' } });
    await fixture.whenStable();
    fireEvent.change(select, { target: { value: 'none' } });
    await fixture.whenStable();
    expect(changed).toHaveBeenLastCalledWith({ appAi: 'none' });
    expect(
      screen.queryByRole('button', { name: 'Ceder assim mesmo' }),
    ).toBeNull();
    fireEvent.change(select, { target: { value: 'claude-subscription' } });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('checkbox', { name: /Usar sempre/ }));
    await fixture.whenStable();
    expect(
      screen.queryByRole('button', { name: 'Ceder assim mesmo' }),
    ).toBeNull();
    expect(changed).not.toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionTermsAccepted: true }),
    );
  });

  it('KBC-024: offers the subscription only to the owner, and says when it is not ready', async () => {
    const { fixture } = await renderEditor();
    expect(
      screen.queryByRole('option', { name: /Claude do administrador/ }),
    ).toBeNull();
    fixture.componentRef.setInput('lending', {
      canLend: true,
      lendable: LEND_NONE,
    });
    await fixture.whenStable();
    expect(
      screen.getByRole('option', { name: /Claude do administrador/ }),
    ).toBeTruthy();
    // Said only where it matters: the subscription chosen or assigned (review R9).
    expect(
      screen.queryByText(/não está disponível agora no servidor/),
    ).toBeNull();
    fireEvent.change(screen.getByLabelText('Qual IA atende esta pessoa'), {
      target: { value: 'claude-subscription' },
    });
    await fixture.whenStable();
    expect(
      screen.getByText(/não está disponível agora no servidor/),
    ).toBeTruthy();
  });

  it('KBC-024: says in the history that the terms were confirmed', async () => {
    await renderEditor({
      ...DEFAULT_PERSON_AI,
      appAi: 'claude-subscription',
      history: [
        {
          appAi: 'claude-subscription',
          enforced: false,
          by: 'owner@x.com',
          at: '2026-10-26T12:00:00.000Z',
          termsAccepted: true,
        },
      ],
    });
    expect(screen.getByText(/termos confirmados/)).toBeTruthy();
  });

  it('KBC-024 QA R2-1: focus returns to the choice once the save is over', async () => {
    const changed = vi.fn();
    const { fixture } = await render(PersonAiEditor, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        ai: DEFAULT_PERSON_AI,
        defaultAppAi: 'house',
        lending: { canLend: true, lendable: LEND_ALL },
      },
      on: { changed },
    });
    const select = screen.getByLabelText('Qual IA atende esta pessoa');
    fireEvent.change(select, { target: { value: 'claude-subscription' } });
    await fixture.whenStable();
    fixture.componentRef.setInput('busy', true);
    await fixture.whenStable();
    // Saving: the confirmation cannot be sent twice (review R7).
    expect(
      (
        screen.getByRole('button', {
          name: 'Ceder assim mesmo',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fixture.componentRef.setInput('busy', false);
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Ceder assim mesmo' }));
    fixture.componentRef.setInput('busy', true);
    await fixture.whenStable();
    fixture.componentRef.setInput('busy', false);
    await fixture.whenStable();
    expect(document.activeElement).toBe(select);
  });

  it('KBC-024 QA R2-3: another master sees how much a lent person uses as the owner’s call', async () => {
    await renderEditor({ ...DEFAULT_PERSON_AI, appAi: 'claude-subscription' });
    expect(
      (
        screen.getByRole('checkbox', {
          name: /Usar sempre/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByLabelText(
          'Pesquisas por dia (vazio = padrão)',
        ) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    const hint = screen.getByText(/Só o dono muda o uso da assinatura cedida/);
    expect(
      screen
        .getByRole('checkbox', { name: /Usar sempre/ })
        .getAttribute('aria-describedby'),
    ).toBe(hint.id);
    // Revoking stays open.
    expect(
      (screen.getByLabelText('Qual IA atende esta pessoa') as HTMLSelectElement)
        .disabled,
    ).toBe(false);
  });

  it('KBC-027 AC-5: lends the ChatGPT subscription after the OpenAI terms', async () => {
    const changed = vi.fn();
    const { fixture } = await render(PersonAiEditor, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        ai: DEFAULT_PERSON_AI,
        defaultAppAi: 'house',
        lending: { canLend: true, lendable: LEND_ALL },
      },
      on: { changed },
    });
    fireEvent.change(screen.getByLabelText('Qual IA atende esta pessoa'), {
      target: { value: 'chatgpt-subscription' },
    });
    await fixture.whenStable();
    const confirm = screen.getByRole('group', {
      name: 'Ceder a assinatura do ChatGPT a esta pessoa?',
    });
    expect(confirm.textContent).toContain('Os termos da OpenAI não permitem');
    fireEvent.click(screen.getByRole('button', { name: 'Ceder assim mesmo' }));
    expect(changed).toHaveBeenLastCalledWith({
      appAi: 'chatgpt-subscription',
      subscriptionTermsAccepted: true,
    });
  });
});
