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
  const lendPending = vi.fn();
  const view = await render(InvitePresetEditor, {
    providers: [provideZonelessChangeDetection()],
    inputs: { preset, topics: TOPICS.items, defaultAppAi: 'house', lending },
    on: { changed, invalidChange, lendPending },
  });
  return { ...view, changed, invalidChange, lendPending };
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
    const { changed, invalidChange, lendPending, fixture } = await renderEditor(
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
    expect(lendPending).toHaveBeenLastCalledWith(true);
    // The person does not exist yet: the title names who is being invited (design R1-4).
    const confirm = screen.getByRole('group', {
      name: 'Ceder a assinatura do Claude a quem você está convidando?',
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
    expect(lendPending).toHaveBeenLastCalledWith(false);
    await fixture.whenStable();
    expect(document.activeElement).toBe(select);
  });

  it('announces which terms were confirmed and how to undo it (design R1-3)', async () => {
    const preset = plainPreset();
    await renderEditor(
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
    expect(
      screen.getAllByRole('status').map((status) => status.textContent),
    ).toContainEqual(
      expect.stringContaining(
        'Termos da assinatura do Claude confirmados para este convite. Para desfazer, escolha outra IA.',
      ),
    );
  });

  it('keeps the pending choice shown while another field changes (review R1)', async () => {
    const { fixture, changed } = await renderEditor(
      plainPreset(),
      OWNER_LENDS_CLAUDE,
    );
    const select = screen.getByLabelText(
      'Qual IA atende a pessoa',
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'claude-subscription' } });
    await fixture.whenStable();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermetismo' }));
    fixture.componentRef.setInput('preset', last(changed));
    await fixture.whenStable();
    expect(select.value).toBe('claude-subscription');
    expect(
      screen.getByRole('group', { name: /Ceder a assinatura do Claude/ }),
    ).toBeTruthy();
  });

  it('tells the owner why a subscription is not offered now (design R1-5)', async () => {
    await renderEditor(plainPreset(), OWNER_LENDS_CLAUDE);
    expect(
      screen.getByText(
        /A assinatura do ChatGPT não aparece agora: está desligada em IA da aplicação, sem login no servidor ou com o contêiner do Codex sem responder\./,
      ),
    ).toBeTruthy();
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
    expect(document.activeElement).toBe(select);
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
  it('KBC-099 AC-14: offers "Pesquisar faixas com IA", unchecked on a new preset', async () => {
    await renderEditor();
    const box = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Pesquisar faixas com IA',
    });
    expect(box.checked).toBe(false);
    expect(box.matches(':disabled')).toBe(false);
  });

  it('offers voice profiles to no member (ADR 0032)', async () => {
    await renderEditor();
    expect(
      screen.queryByRole('checkbox', { name: 'Cadastrar perfis de voz' }),
    ).toBeNull();
  });

  it('shows voice profiles on a master preset, with the role (ADR 0032)', async () => {
    await renderEditor({ ...plainPreset(), role: 'master' });
    const box = screen.getByRole<HTMLInputElement>('checkbox', {
      name: 'Cadastrar perfis de voz',
    });
    expect(box.checked).toBe(true);
    expect(box.matches(':disabled')).toBe(true);
  });

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

/** The editor inside a parent that keeps each change, as the invitation and the profile do. */
async function renderKept(preset: InvitationPreset) {
  const changed = vi.fn();
  const view = await render(InvitePresetEditor, {
    providers: [provideZonelessChangeDetection()],
    inputs: { preset, topics: TOPICS.items },
    on: {
      changed: (next: InvitationPreset) => {
        changed(next);
        view.fixture.componentRef.setInput('preset', next);
      },
    },
  });
  const settle = () => view.fixture.whenStable();
  const defaultTopic = () =>
    screen.getByLabelText('Acervo padrão') as HTMLSelectElement;
  return { ...view, changed, settle, defaultTopic };
}

const HINT =
  'Marque ao menos um acervo em “Acervos” acima para escolher o padrão.';
const CLEARED =
  'O acervo padrão foi limpo porque ele não está mais entre os acervos marcados.';

describe('InvitePresetEditor explains the default collection (KBC-033)', () => {
  it('says why only "Sem preferência" is offered while no collection is checked (AC-1)', async () => {
    const { settle, defaultTopic } = await renderKept(plainPreset());
    expect(optionsOf(defaultTopic())).toEqual(['']);
    const hint = screen.getByText(HINT);
    expect(defaultTopic().getAttribute('aria-describedby')).toBe(hint.id);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermetismo' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alquimia' }));
    await settle();
    expect(screen.queryByText(HINT)).toBeNull();
    expect(defaultTopic().hasAttribute('aria-describedby')).toBe(false);
  });

  it('gives no hint to a master, who sees every collection (AC-1)', async () => {
    await renderKept({ ...plainPreset(), role: 'master' });
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('preselects the only checked collection, still changeable to "Sem preferência" (AC-2)', async () => {
    const { changed, settle, defaultTopic } = await renderKept(plainPreset());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alquimia' }));
    await settle();
    expect(last(changed).preferences).toEqual({ defaultTopic: 'alquimia' });
    expect(defaultTopic().value).toBe('alquimia');
    fireEvent.change(defaultTopic(), { target: { value: '' } });
    await settle();
    expect(last(changed).preferences).toEqual({});
    expect(defaultTopic().value).toBe('');
  });

  it('never picks again once "Sem preferência" was chosen (AC-2, BR-2)', async () => {
    const { changed, settle, defaultTopic } = await renderKept({
      ...plainPreset(),
      topics: ['hermetismo', 'alquimia'],
    });
    fireEvent.change(defaultTopic(), { target: { value: '' } });
    await settle();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alquimia' }));
    await settle();
    expect(last(changed).topics).toEqual(['hermetismo']);
    expect(last(changed).preferences).toEqual({});
  });

  it('never replaces a default already chosen (AC-2, BR-2)', async () => {
    const { changed, settle } = await renderKept({
      ...plainPreset(),
      topics: ['hermetismo', 'alquimia'],
      preferences: { defaultTopic: 'hermetismo' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alquimia' }));
    await settle();
    expect(last(changed).preferences).toEqual({ defaultTopic: 'hermetismo' });
  });

  it('clears the default when its collection is unchecked, and says so politely (AC-3)', async () => {
    const { changed, settle, defaultTopic } = await renderKept({
      ...plainPreset(),
      topics: ['hermetismo', 'alquimia'],
    });
    fireEvent.change(defaultTopic(), { target: { value: 'alquimia' } });
    await settle();
    expect(screen.queryByText(CLEARED)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alquimia' }));
    await settle();
    expect(last(changed).preferences).toEqual({});
    expect(defaultTopic().value).toBe('');
    const notice = screen.getByText(CLEARED);
    expect(notice.closest('[role="status"]')).not.toBeNull();
    // Choosing a default again puts the notice away.
    fireEvent.change(defaultTopic(), { target: { value: 'hermetismo' } });
    await settle();
    expect(screen.queryByText(CLEARED)).toBeNull();
  });

  it('says so too when stepping down from master drops the default (AC-3)', async () => {
    await renderKept({
      ...plainPreset(),
      role: 'master',
      topics: [],
      preferences: { defaultTopic: 'alquimia' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /^Master/ }));
    expect(await screen.findByText(CLEARED)).toBeTruthy();
    expect(screen.getByText(HINT)).toBeTruthy();
  });
});

describe('InvitePresetEditor: levels (KBC-109 FR-5, BR-1, BR-5, AC-7)', () => {
  const SCALES = [
    {
      collection: 'hermetismo',
      levels: [
        { id: 'qs', code: 'QS' },
        { id: 'ci', code: 'CI' },
      ],
    },
  ];

  async function renderLevels(
    preset: InvitationPreset,
    staleLevels: Record<string, string> = {},
  ) {
    const changed = vi.fn();
    const view = await render(InvitePresetEditor, {
      providers: [provideZonelessChangeDetection()],
      inputs: {
        preset,
        topics: TOPICS.items,
        scales: SCALES,
        staleLevels,
      },
      on: { changed },
    });
    return { ...view, changed };
  }

  it('shows "Nível em Hermetismo" under a marked Hermetismo, the lowest by default, and sends the choice', async () => {
    const { changed } = await renderLevels({
      ...plainPreset(),
      topics: ['hermetismo'],
    });
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Nível em Hermetismo',
    });
    expect(select.value).toBe('qs');
    expect(
      screen.getByRole('group', { name: 'Acervos' }).contains(select),
    ).toBe(true);
    fireEvent.change(select, { target: { value: 'ci' } });
    expect(last(changed).levels).toEqual({ hermetismo: 'ci' });
  });

  it('BR-1: unmarking the collection drops its level; marking it gives the lowest', async () => {
    const { changed } = await renderLevels({
      ...plainPreset(),
      topics: ['hermetismo'],
      levels: { hermetismo: 'ci' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermetismo' }));
    expect(last(changed).levels).toBeUndefined();
    expect(last(changed).topics).toEqual([]);
  });

  it('BR-1: a collection without a scale gets no select and no level', async () => {
    const { changed } = await renderLevels(plainPreset());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Alquimia' }));
    expect(screen.queryByRole('combobox', { name: /Nível em/ })).toBeNull();
    expect(last(changed).levels).toBeUndefined();
  });

  it('BR-5: a master preset has no select, says why and keeps no level', async () => {
    const { changed } = await renderLevels({
      ...plainPreset(),
      topics: ['hermetismo'],
      levels: { hermetismo: 'ci' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /^Master/ }));
    expect(last(changed)).toMatchObject({ role: 'master' });
    expect(last(changed).levels).toBeUndefined();
  });

  it('BR-3, invitation: says a level that no longer exists gives the lowest', async () => {
    await renderLevels(
      {
        ...plainPreset(),
        topics: ['hermetismo'],
        levels: { hermetismo: 'qs' },
      },
      { hermetismo: 'cdc' },
    );
    const select = screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Nível em Hermetismo',
    });
    expect(select.value).toBe('qs');
    const note = screen.getByText(
      /O nível cdc não existe mais; este convite dá o nível mais baixo\./,
    );
    expect(select.getAttribute('aria-describedby')).toBe(note.id);
    fireEvent.change(select, { target: { value: 'ci' } });
    expect(screen.queryByText(/não existe mais/)).toBeNull();
  });
});

describe('InvitePresetEditor in a profile (KBC-109 R1-1, R1-2, R1-3)', () => {
  const SCALES = [
    {
      collection: 'hermetismo',
      levels: [
        { id: 'qs', code: 'QS' },
        { id: 'ci', code: 'CI' },
      ],
    },
  ];

  async function renderProfile(
    preset: InvitationPreset,
    scales: typeof SCALES | null = SCALES,
  ) {
    const changed = vi.fn();
    const view = await render(InvitePresetEditor, {
      providers: [provideZonelessChangeDetection()],
      inputs: { preset, topics: TOPICS.items, scales, mode: 'profile' },
      on: { changed },
    });
    return { ...view, changed };
  }

  const levelSelect = () =>
    screen.getByRole<HTMLSelectElement>('combobox', {
      name: 'Nível em Hermetismo',
    });

  it('R1-2: a collection the profile names no level for keeps the person level, and may name one', async () => {
    const { changed } = await renderProfile({
      ...plainPreset(),
      topics: ['hermetismo'],
    });
    expect(levelSelect().value).toBe(':keep');
    expect(
      within(levelSelect())
        .getAllByRole('option')
        .map((one) => one.textContent?.trim()),
    ).toEqual(['Manter o nível da pessoa', 'QS', 'CI']);
    fireEvent.change(levelSelect(), { target: { value: 'ci' } });
    expect(last(changed).levels).toEqual({ hermetismo: 'ci' });
    fireEvent.change(levelSelect(), { target: { value: ':keep' } });
    expect(last(changed).levels).toBeUndefined();
  });

  it('R1-2: marking a collection keeps the person level by default', async () => {
    const { changed } = await renderProfile(plainPreset());
    fireEvent.click(screen.getByRole('checkbox', { name: 'Hermetismo' }));
    expect(last(changed).topics).toEqual(['hermetismo']);
    expect(last(changed).levels).toBeUndefined();
  });

  it('R1-3: a level that no longer exists asks for a choice; choosing the lowest is a choice', async () => {
    const { changed } = await renderProfile({
      ...plainPreset(),
      topics: ['hermetismo'],
      levels: { hermetismo: 'cdc' },
    });
    expect(levelSelect().value).toBe(':choose');
    const warning = screen.getByText(
      /O nível cdc não existe mais; escolha outro\./,
    );
    expect(levelSelect().getAttribute('aria-describedby')).toContain(
      warning.id,
    );
    fireEvent.change(levelSelect(), { target: { value: 'qs' } });
    expect(last(changed).levels).toEqual({ hermetismo: 'qs' });
  });

  it('R1-1: without the scales, no select and the levels stay as they came', async () => {
    const { changed } = await renderProfile(
      {
        ...plainPreset(),
        topics: ['hermetismo'],
        levels: { hermetismo: 'ci' },
      },
      null,
    );
    expect(screen.queryByRole('combobox', { name: /Nível em/ })).toBeNull();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Pesquisa com IA' }));
    expect(last(changed).levels).toEqual({ hermetismo: 'ci' });
  });

  it('R3-1: the invitation hint is only for "Manter"; a named level or "Escolha" has none', async () => {
    const hint =
      'Ao convidar com este perfil, a pessoa entra no nível mais baixo.';
    const { fixture } = await renderProfile({
      ...plainPreset(),
      topics: ['hermetismo'],
    });
    expect(levelSelect().getAttribute('aria-describedby')).toContain(
      screen.getByText(hint).id,
    );

    fireEvent.change(levelSelect(), { target: { value: 'ci' } });
    fixture.componentRef.setInput('preset', {
      ...plainPreset(),
      topics: ['hermetismo'],
      levels: { hermetismo: 'ci' },
    });
    await fixture.whenStable();
    expect(screen.queryByText(hint)).toBeNull();
    expect(levelSelect().getAttribute('aria-describedby')).toBeNull();

    fixture.componentRef.setInput('preset', {
      ...plainPreset(),
      topics: ['hermetismo'],
      levels: { hermetismo: 'gone' },
    });
    await fixture.whenStable();
    expect(screen.queryByText(hint)).toBeNull();
    expect(levelSelect().getAttribute('aria-describedby')).toBe(
      screen.getByText(/O nível gone não existe mais/).id,
    );
  });
});
