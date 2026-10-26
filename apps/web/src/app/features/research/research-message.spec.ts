import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { SettingsStore } from '@features/settings/settings-store.js';
import { ResearchMessage } from './research-message.js';
import { startTurn, type ResearchTurn } from './research-turn.js';

const SOURCES = [
  { n: 1, id: 'raw/a.md', title: 'Os Princípios' },
  { n: 2, id: 'raw/b.md', title: 'O Caibalion' },
  { n: 3, id: 'raw/c.md', title: 'Não citado' },
];

const aTurn = (overrides: Partial<ResearchTurn> = {}): ResearchTurn => ({
  ...startTurn(1, 'quais são os princípios?'),
  phase: 'done',
  text: 'São sete [1], descritos no Caibalion [2].',
  sources: SOURCES,
  steps: [
    { kind: 'search', text: 'Buscando “princípios ocultos”' },
    { kind: 'search', text: 'Buscando “princípios herméticos”' },
    { kind: 'read', text: 'Lendo “Os Princípios”' },
  ],
  stepCount: 3,
  usd: 0.0042,
  model: 'm',
  ...overrides,
});

async function renderMessage(turn: ResearchTurn, last = true) {
  const opened = vi.fn();
  const stopped = vi.fn();
  const retried = vi.fn();
  const settings = { openSettings: vi.fn() };
  const view = await render(ResearchMessage, {
    providers: [
      provideZonelessChangeDetection(),
      { provide: SettingsStore, useValue: settings },
    ],
    inputs: { turn, last },
    on: { opened, stopped, retried },
  });
  return { ...view, opened, stopped, retried, settings };
}

describe('ResearchMessage', () => {
  it('names each sub-researcher in the steps and counts them in the summary (KBC-018 AC-4)', async () => {
    await renderMessage(
      aTurn({
        steps: [
          { kind: 'search', text: 'Procurando o texto “obra”' },
          { kind: 'delegate', text: 'Livros 1–60', agent: 1 },
          { kind: 'delegate', text: 'Livros 61–120', agent: 2 },
          { kind: 'search', text: 'Procurando o texto “livro”', agent: 1 },
          { kind: 'read', text: 'Lendo “Miasmas”', agent: 2 },
        ],
      }),
    );
    expect(screen.getByText('Pesquisador 1: Livros 1–60')).toBeTruthy();
    const step = screen.getByText('Pesquisador 2: Lendo “Miasmas”');
    expect(step.tagName).toBe('LI');
    expect(step.classList.contains('sub')).toBe(true);
    expect(
      screen.getByText('Pesquisou 2 vezes · leu 1 documento · 2 pesquisadores'),
    ).toBeTruthy();
  });

  it('shows a delegation of the Claude Code path as it came, without a number', async () => {
    await renderMessage(
      aTurn({
        steps: [{ kind: 'delegate', text: 'Delegando: Livros 1–60' }],
      }),
    );
    expect(screen.getByText('Delegando: Livros 1–60')).toBeTruthy();
  });

  it('lists what the agent thought aloud among the steps, apart from the answer (ADR 0009)', async () => {
    await renderMessage(
      aTurn({
        steps: [
          { kind: 'thought', text: 'Os textos sobre isso são dois.' },
          { kind: 'read', text: 'Lendo “Os Princípios”' },
        ],
      }),
    );
    const thought = screen.getByText(
      'Pensando: Os textos sobre isso são dois.',
    );
    expect(thought.tagName).toBe('LI');
    // The summary counts only what the agent did.
    expect(screen.getByText('Leu 1 documento')).toBeTruthy();
  });

  it('says when a fast answer went on with the deep research (ADR 0009)', async () => {
    await renderMessage(
      aTurn({
        steps: [
          { kind: 'search', text: 'Buscando “princípios ocultos”' },
          { kind: 'deepen', text: 'Aprofundando a pesquisa…' },
          { kind: 'read', text: 'Lendo “Os Princípios”' },
        ],
      }),
    );
    expect(
      screen.getByText(
        'Pesquisou 1 vez · leu 1 documento · aprofundou a pesquisa',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Aprofundando a pesquisa…').tagName).toBe('LI');
  });

  it('counts each document read once, and says a restored turn went deeper', async () => {
    await renderMessage(
      aTurn({
        steps: [
          { kind: 'search', text: 'Buscando “princípios”' },
          { kind: 'read', text: 'Lendo “Os Princípios”' },
          { kind: 'read', text: 'Lendo “Os Princípios”' },
        ],
      }),
    );
    expect(screen.getByText('Pesquisou 1 vez · leu 1 documento')).toBeTruthy();
  });

  it('counts two documents with one title as two (by id)', async () => {
    await renderMessage(
      aTurn({
        steps: [
          { kind: 'search', text: 'Buscando “polaridade”' },
          {
            kind: 'read',
            text: 'Lendo “Polaridade e Correspondência”',
            document: 'raw/a.md',
          },
          {
            kind: 'read',
            text: 'Lendo “Polaridade e Correspondência”',
            document: 'raw/b.md',
          },
        ],
      }),
    );
    expect(screen.getByText('Pesquisou 1 vez · leu 2 documentos')).toBeTruthy();
  });

  it('shows "aprofundou a pesquisa" on a restored escalated turn', async () => {
    await renderMessage(
      aTurn({ steps: [], stepCount: 13, escalated: true, restored: true }),
    );
    expect(
      screen.getByText('13 passos de pesquisa · aprofundou a pesquisa'),
    ).toBeTruthy();
  });

  it('shows the thought as the live step while the agent works', async () => {
    await renderMessage(
      aTurn({
        phase: 'streaming',
        text: '',
        steps: [{ kind: 'thought', text: 'Vou ler dois textos.' }],
      }),
    );
    expect(screen.getAllByText('Pensando: Vou ler dois textos.')).toHaveLength(
      2,
    );
  });

  it('opens the cited document from [n] and from the sources list (AC-3)', async () => {
    const view = await renderMessage(aTurn());
    fireEvent.click(screen.getByRole('link', { name: 'Fonte 2: O Caibalion' }));
    expect(view.opened).toHaveBeenCalledWith({
      id: 'raw/b.md',
      title: 'O Caibalion',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Os Princípios' }));
    expect(view.opened).toHaveBeenLastCalledWith({
      id: 'raw/a.md',
      title: 'Os Princípios',
    });
    // Only the documents the answer cites are listed as sources.
    expect(screen.queryByRole('button', { name: 'Não citado' })).toBeNull();
  });

  it('summarizes the steps in one line that expands to the step texts', async () => {
    await renderMessage(aTurn());
    const summary = screen.getByText('Pesquisou 2 vezes · leu 1 documento');
    expect(summary.closest('summary')).toBeTruthy();
    expect(screen.getByText('Buscando “princípios herméticos”')).toBeTruthy();
  });

  it('shows the AI notice with the cost, and no cost for a subscription', async () => {
    const view = await renderMessage(aTurn());
    expect(
      screen.getByText(
        'Resposta gerada por IA a partir do acervo; confira nas fontes.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/^Custo: US\$\s0,0042$/)).toBeTruthy();
    expect(screen.queryByText('Incluído na sua assinatura')).toBeNull();
    view.fixture.componentRef.setInput(
      'turn',
      aTurn({ usd: 0, billing: 'subscription' }),
    );
    await view.fixture.whenStable();
    expect(screen.queryByText(/Custo:/)).toBeNull();
    expect(screen.getByText('Incluído na sua assinatura')).toBeTruthy();
  });

  it('keeps the partial-cost note off an interrupted subscription turn', async () => {
    const view = await renderMessage(aTurn({ interrupted: true }));
    expect(screen.getByText(/O custo do que já foi processado/)).toBeTruthy();
    view.fixture.componentRef.setInput(
      'turn',
      aTurn({ interrupted: true, billing: 'subscription', usd: 0 }),
    );
    await view.fixture.whenStable();
    expect(screen.queryByText(/O custo do que já foi processado/)).toBeNull();
  });

  it.each([
    ['CLI_LOGIN_REQUIRED', /não está logado/],
    ['PROVIDER_UNAVAILABLE', /não respondeu agora/],
    ['LLM_KEY_REJECTED', /chave de API não foi aceita/],
    ['LLM_NOT_CONFIGURED', /Escolha um em ⚙ Configurações/],
  ] as const)('explains the runner failure %s', async (error, text) => {
    await renderMessage(aTurn({ phase: 'error', text: '', error }));
    expect(screen.getByRole('alert').textContent).toMatch(text);
  });

  it('shows the current step and "Parar" while the agent works', async () => {
    const view = await renderMessage(
      aTurn({ phase: 'streaming', text: '', usd: null }),
    );
    expect(screen.getByRole('article').getAttribute('aria-busy')).toBe('true');
    expect(
      screen.getByText('Lendo “Os Princípios”', { selector: 'summary *' }),
    ).toBeTruthy();
    expect(screen.queryByText(/Resposta gerada por IA/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Parar' }));
    expect(view.stopped).toHaveBeenCalledOnce();
  });

  it('says how many steps a restored answer took, without a list', async () => {
    await renderMessage(aTurn({ steps: [], stepCount: 4, restored: true }));
    expect(screen.getByText('4 passos de pesquisa')).toBeTruthy();
    expect(screen.queryByRole('group')).toBeNull();
  });

  it('explains a missing credit with the link, and retries the last turn', async () => {
    const view = await renderMessage(
      aTurn({ phase: 'error', text: '', error: 'LLM_INSUFFICIENT_CREDIT' }),
    );
    expect(screen.getByRole('alert').textContent).toMatch(
      /créditos da OpenRouter acabaram/,
    );
    expect(
      screen
        .getByRole('link', { name: 'Adicionar créditos' })
        .getAttribute('href'),
    ).toBe('https://openrouter.ai/settings/credits');
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(view.retried).toHaveBeenCalledOnce();
  });

  it('points a spent daily cap to Settings, without "Tentar de novo"', async () => {
    const view = await renderMessage(
      aTurn({ phase: 'error', text: '', error: 'DAILY_CAP_REACHED' }),
    );
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    fireEvent.click(
      screen.getByRole('button', { name: 'Abrir Configurações' }),
    );
    expect(view.settings.openSettings).toHaveBeenCalledOnce();
  });

  it('offers "Tentar de novo" on a stop before any text, with no cost notice', async () => {
    const view = await renderMessage(
      aTurn({ text: '', interrupted: true, usd: 0 }),
    );
    expect(
      screen.getByText('Resposta interrompida antes de começar.'),
    ).toBeTruthy();
    expect(screen.queryByText(/O custo do que já foi processado/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(view.retried).toHaveBeenCalledOnce();
  });

  it('uses the AI wording for the rate limit and marks a stopped answer', async () => {
    const view = await renderMessage(
      aTurn({ phase: 'error', text: '', error: 'RATE_LIMITED' }),
      false,
    );
    expect(screen.getByRole('alert').textContent).toMatch(
      /Muitas respostas em pouco tempo/,
    );
    expect(screen.queryByRole('button', { name: 'Tentar de novo' })).toBeNull();
    view.fixture.componentRef.setInput('turn', aTurn({ interrupted: true }));
    await view.fixture.whenStable();
    expect(screen.getByText('(interrompida)')).toBeTruthy();
  });
});
