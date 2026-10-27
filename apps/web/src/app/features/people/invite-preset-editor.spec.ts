import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type { InvitationPreset } from '@kb-chat/contracts';
import { TOPICS } from '../../testing/fixtures.js';
import { InvitePresetEditor } from './invite-preset-editor.js';
import { NO_LENDING, type Lending } from './lending.js';
import { plainPreset } from './preset-defaults.js';

async function renderEditor(
  preset: InvitationPreset = plainPreset(),
  lending: Lending = NO_LENDING,
) {
  const changed = vi.fn();
  const invalidChange = vi.fn();
  const view = await render(InvitePresetEditor, {
    providers: [provideZonelessChangeDetection()],
    inputs: { preset, topics: TOPICS.items, defaultAppAi: 'house', lending },
    on: { changed, invalidChange },
  });
  return { ...view, changed, invalidChange };
}

const OWNER_LENDS_CLAUDE: Lending = {
  canLend: true,
  lendable: { 'claude-subscription': true, 'chatgpt-subscription': false },
};

const optionsOf = (select: HTMLElement) =>
  within(select)
    .getAllByRole('option')
    .map((option) => (option as HTMLOptionElement).value);

describe('InvitePresetEditor lends a subscription in the invitation (KBC-031)', () => {
  it('offers only what the owner can lend now (AC-7)', async () => {
    await renderEditor(plainPreset(), OWNER_LENDS_CLAUDE);
    expect(optionsOf(screen.getByLabelText('Qual IA atende a pessoa'))).toEqual(
      ['default', 'house', 'claude-subscription', 'none'],
    );
  });

  it('asks for the terms before the preset lends it, and the invitation waits (AC-5)', async () => {
    const { changed, invalidChange, fixture } = await renderEditor(
      plainPreset(),
      OWNER_LENDS_CLAUDE,
    );
    const select = screen.getByLabelText(
      'Qual IA atende a pessoa',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'claude-subscription' } });
    await fixture.whenStable();
    expect(changed).not.toHaveBeenCalled();
    expect(invalidChange).toHaveBeenLastCalledWith(true);
    const confirm = screen.getByRole('group', {
      name: 'Ceder a assinatura do Claude a esta pessoa?',
    });
    expect(confirm.textContent).toContain(
      'Os termos da Anthropic não permitem',
    );
    expect(document.activeElement).toBe(
      within(confirm).getByRole('button', { name: 'Cancelar' }),
    );
    fireEvent.click(
      within(confirm).getByRole('button', { name: 'Ceder assim mesmo' }),
    );
    expect(last(changed).ai).toMatchObject({
      appAi: 'claude-subscription',
      subscriptionTermsAccepted: true,
    });
    expect(invalidChange).toHaveBeenLastCalledWith(false);
  });

  it('goes back to the earlier choice when the lending is cancelled', async () => {
    const { changed, fixture } = await renderEditor(
      plainPreset(),
      OWNER_LENDS_CLAUDE,
    );
    const select = screen.getByLabelText(
      'Qual IA atende a pessoa',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'claude-subscription' } });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    await fixture.whenStable();
    expect(changed).not.toHaveBeenCalled();
    expect(select.value).toBe('default');
    expect(
      screen.queryByRole('group', { name: /Ceder a assinatura/ }),
    ).toBeNull();
  });

  it('drops the confirmed terms when another AI is chosen', async () => {
    const preset = plainPreset();
    const { changed } = await renderEditor(
      {
        ...preset,
        ai: {
          ...preset.ai,
          appAi: 'claude-subscription',
          subscriptionTermsAccepted: true,
        },
      },
      OWNER_LENDS_CLAUDE,
    );
    fireEvent.change(screen.getByLabelText('Qual IA atende a pessoa'), {
      target: { value: 'house' },
    });
    expect(last(changed).ai.appAi).toBe('house');
    expect(last(changed).ai).not.toHaveProperty('subscriptionTermsAccepted');
  });

  it('offers no subscription to a master who is not the owner (AC-7)', async () => {
    await renderEditor(plainPreset(), {
      canLend: false,
      lendable: { 'claude-subscription': true, 'chatgpt-subscription': true },
    });
    expect(optionsOf(screen.getByLabelText('Qual IA atende a pessoa'))).toEqual(
      ['default', 'house', 'none'],
    );
  });
});

const last = (changed: ReturnType<typeof vi.fn>): InvitationPreset =>
  changed.mock.lastCall?.[0] as InvitationPreset;

describe('InvitePresetEditor (KBC-028 AC-2)', () => {
  it('starts as the plain invitation and sends the whole preset up', async () => {
    const { changed } = await renderEditor();
    const collections = screen.getByRole('group', { name: 'Acervos' });
    expect(
      within(collections)
        .getAllByRole('checkbox')
        .some((box) => (box as HTMLInputElement).checked),
    ).toBe(false);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermetismo' }));
    expect(last(changed)).toMatchObject({
      role: 'member',
      topics: ['hermetismo'],
      features: ['search'],
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pesquisa com IA' }));
    expect(last(changed).features).toEqual(['search', 'research']);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Master/ }));
    expect(last(changed).role).toBe('master');
  });

  it('never offers a subscription (BR-2) and keeps the AI limits', async () => {
    const { changed } = await renderEditor();
    const select = screen.getByLabelText('Qual IA atende a pessoa');
    const options = within(select)
      .getAllByRole('option')
      .map((option) => (option as HTMLOptionElement).value);
    expect(options).toEqual(['default', 'house', 'none']);
    fireEvent.change(select, { target: { value: 'house' } });
    expect(last(changed).ai.appAi).toBe('house');
    fireEvent.click(screen.getByRole('checkbox', { name: /Usar sempre/ }));
    expect(last(changed).ai.enforced).toBe(true);
    fireEvent.change(
      screen.getByLabelText('Pesquisas por dia (vazio = padrão)'),
      { target: { value: '3' } },
    );
    expect(last(changed).ai.dailyResearches).toBe(3);
    fireEvent.click(screen.getByRole('checkbox', { name: /modelo pago/ }));
    expect(last(changed).ai.paidFallback).toEqual({
      enabled: true,
      monthlyCapUsd: 1,
    });
  });

  it('says why a typed number is not kept, on its field', async () => {
    const preset = plainPreset();
    const { changed, fixture } = await renderEditor({
      ...preset,
      ai: { ...preset.ai, paidFallback: { enabled: true, monthlyCapUsd: 2 } },
    });
    const daily = screen.getByLabelText('Pesquisas por dia (vazio = padrão)');
    fireEvent.change(daily, { target: { value: '2.5' } });
    await fixture.whenStable();
    expect(changed).not.toHaveBeenCalled();
    expect(daily.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toContain('número inteiro');
    fireEvent.change(screen.getByLabelText('Teto por mês (US$)'), {
      target: { value: '-1' },
    });
    await fixture.whenStable();
    expect(changed).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Teto por mês (US$)'), {
      target: { value: '4' },
    });
    expect(last(changed).ai.paidFallback.monthlyCapUsd).toBe(4);
  });

  it('sets the initial preferences, the default collection among those granted (BR-4)', async () => {
    const { changed } = await renderEditor({
      ...plainPreset(),
      topics: ['hermetismo'],
    });
    const topic = screen.getByLabelText('Acervo padrão');
    expect(
      within(topic)
        .getAllByRole('option')
        .map((o) => o.textContent?.trim()),
    ).toEqual(['Sem preferência', 'Hermetismo']);
    fireEvent.change(topic, { target: { value: 'hermetismo' } });
    expect(last(changed).preferences).toEqual({ defaultTopic: 'hermetismo' });
    fireEvent.change(screen.getByLabelText('Tema'), {
      target: { value: 'dark' },
    });
    fireEvent.change(screen.getByLabelText('Visão inicial'), {
      target: { value: 'research' },
    });
    fireEvent.change(screen.getByLabelText('Perfil de pesquisa'), {
      target: { value: 'fast' },
    });
    expect(last(changed).preferences).toMatchObject({
      researchProfile: 'fast',
    });
  });

  it('taking a collection away drops it as the default; "Sem preferência" drops a key', async () => {
    const { changed } = await renderEditor({
      ...plainPreset(),
      topics: ['hermetismo'],
      preferences: { defaultTopic: 'hermetismo', theme: 'dark' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermetismo' }));
    expect(last(changed)).toMatchObject({
      topics: [],
      preferences: { theme: 'dark' },
    });
    expect(last(changed).preferences).not.toHaveProperty('defaultTopic');
    fireEvent.change(screen.getByLabelText('Tema'), { target: { value: '' } });
    expect(last(changed).preferences).toEqual({ defaultTopic: 'hermetismo' });
  });

  it('a master sees every collection, and stepping down keeps the default only if granted', async () => {
    const { changed } = await renderEditor({
      ...plainPreset(),
      role: 'master',
      preferences: { defaultTopic: 'alquimia' },
    });
    expect(
      within(screen.getByLabelText('Acervo padrão')).getAllByRole('option'),
    ).toHaveLength(3);
    fireEvent.click(screen.getByRole('checkbox', { name: /^Master/ }));
    expect(last(changed).role).toBe('member');
    expect(last(changed).preferences).toEqual({});
  });

  it('says when a typed number is not kept, and when it is again (design D4)', async () => {
    const invalidChange = vi.fn();
    await render(InvitePresetEditor, {
      providers: [provideZonelessChangeDetection()],
      inputs: { preset: plainPreset(), topics: TOPICS.items },
      on: { invalidChange },
    });
    const daily = screen.getByLabelText('Pesquisas por dia (vazio = padrão)');
    fireEvent.change(daily, { target: { value: '-3' } });
    expect(invalidChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(daily, { target: { value: '4' } });
    expect(invalidChange).toHaveBeenLastCalledWith(false);
  });

  it('turns the AI limits off with "Nenhuma" and says why', async () => {
    const preset = plainPreset();
    await renderEditor({ ...preset, ai: { ...preset.ai, appAi: 'none' } });
    const limits = screen.getByRole('group', {
      name: 'Limites da IA da aplicação',
    }) as HTMLFieldSetElement;
    expect(limits.disabled).toBe(true);
    expect(
      screen.getByText(/a cota e a reserva paga não se aplicam/),
    ).toBeTruthy();
  });

  it('"Nenhuma" clears a pending bad number, so nothing stays held (review N-1)', async () => {
    const invalidChange = vi.fn();
    const { fixture } = await render(InvitePresetEditor, {
      providers: [provideZonelessChangeDetection()],
      inputs: { preset: plainPreset(), topics: TOPICS.items },
      on: { invalidChange },
    });
    fireEvent.change(
      screen.getByLabelText('Pesquisas por dia (vazio = padrão)'),
      { target: { value: '-5' } },
    );
    expect(invalidChange).toHaveBeenLastCalledWith(true);
    fireEvent.change(screen.getByLabelText('Qual IA atende a pessoa'), {
      target: { value: 'none' },
    });
    await fixture.whenStable();
    expect(invalidChange).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
