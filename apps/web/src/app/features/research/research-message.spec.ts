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

const TRACK = {
  n: 4,
  id: 'raw/media/r/t.md',
  title: 'O que é o ritmo?',
  authorship: 'mestre-laercio' as const,
  media: {
    mediaId: '0b9c1f7e-1111-4a2b-8c3d-000000000001',
    kind: 'track' as const,
    recordingTitle: 'Palestra de 12/03/2017',
    ordinal: 3,
    total: 12,
    durationMs: 508_000,
    confidence: 'normal' as const,
  },
  passages: [
    { at: '0:41', startMs: 41_300, endMs: 70_000 },
    { at: '1:10', startMs: 70_000, endMs: 95_000 },
  ],
};

async function renderMessage(turn: ResearchTurn, last = true) {
  const opened = vi.fn();
  const trackOpened = vi.fn();
  const stopped = vi.fn();
  const retried = vi.fn();
  const settings = { openSettings: vi.fn() };
  const view = await render(ResearchMessage, {
    providers: [
      provideZonelessChangeDetection(),
      { provide: SettingsStore, useValue: settings },
    ],
    inputs: { turn, last },
    on: { opened, trackOpened, stopped, retried },
  });
  return { ...view, opened, trackOpened, stopped, retried, settings };
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
    // Each delegation heads a nested list with its sub-researcher's own steps.
    const top = [...document.querySelectorAll('details.steps > ol > li')];
    expect(top.map((li) => li.firstChild?.textContent?.trim())).toEqual([
      'Procurando o texto “obra”',
      'Pesquisador 1 — Livros 1–60',
      'Pesquisador 2 — Livros 61–120',
    ]);
    const nested = (li: Element | undefined) =>
      [...(li?.querySelectorAll('ol.sub-steps > li') ?? [])].map((c) =>
        c.textContent?.trim(),
      );
    expect(nested(top[1])).toEqual(['Procurando o texto “livro”']);
    expect(nested(top[2])).toEqual(['Lendo “Miasmas”']);
    expect(
      screen.getByText('Pesquisou 2 vezes · leu 1 documento · 2 pesquisadores'),
    ).toBeTruthy();
  });

  it('numbers a sub-researcher step whose delegation it never received', async () => {
    await renderMessage(
      aTurn({ steps: [{ kind: 'search', text: 'Procurando “x”', agent: 4 }] }),
    );
    expect(screen.getByText('Pesquisador 4: Procurando “x”')).toBeTruthy();
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

  it('KBC-099 AC-8: a cited track has its chip "♪ title · recording · minute" and opens its passage, never the document panel', async () => {
    const { opened, trackOpened } = await renderMessage(
      aTurn({
        text: 'O ritmo é a lei do pêndulo [4@0:41], que tudo governa [4@1:10]. São sete [1].',
        sources: [...SOURCES, TRACK],
      }),
    );
    const chip = screen.getByRole('button', { name: /O que é o ritmo\?/ });
    const text = chip.textContent?.replace(/\s+/g, ' ') ?? '';
    expect(text).toContain('♪');
    expect(text).toContain('Faixa de áudio:');
    expect(text).toMatch(
      /O que é o ritmo\?\s*Palestra de 12\/03\/2017\s*·\s*0:41\s*\+1 trecho/,
    );
    fireEvent.click(chip);
    expect(trackOpened).toHaveBeenLastCalledWith({
      source: TRACK,
      at: '0:41',
      trigger: chip,
    });
    const second = screen.getByRole('link', {
      name: 'Fonte 4, faixa O que é o ritmo?, aos 1 minuto e 10 segundos',
    });
    fireEvent.click(second);
    expect(trackOpened).toHaveBeenLastCalledWith({
      source: TRACK,
      at: '1:10',
      trigger: second,
    });
    expect(opened).not.toHaveBeenCalled();
  });

  it('KBC-099 AC-15: an answer saved before the tracks keeps its sources as they were', async () => {
    const { opened, trackOpened } = await renderMessage(aTurn());
    fireEvent.click(screen.getByRole('button', { name: /Os Princípios/ }));
    expect(opened).toHaveBeenCalledWith({
      id: 'raw/a.md',
      title: 'Os Princípios',
    });
    expect(trackOpened).not.toHaveBeenCalled();
    expect(document.querySelector('.track-mark')).toBeNull();
  });

  it('groups mixed cited sources by authorship, each with its badge (KBC-020 AC-7)', async () => {
    await renderMessage(
      aTurn({
        text: 'O Mestre ensina [1][3]; o Caibalion diz [2]; a síntese [4].',
        sources: [
          {
            n: 1,
            id: 'raw/a.md',
            title: 'Tema 1',
            authorship: 'mestre-laercio',
          },
          {
            n: 2,
            id: 'raw/b.md',
            title: 'O Caibalion',
            authorship: 'outros-autores',
          },
          {
            n: 3,
            id: 'raw/c.md',
            title: 'Tema 2',
            authorship: 'mestre-laercio',
          },
          { n: 4, id: 'wiki/d.md', title: 'Ritmo', authorship: 'sintese' },
        ],
      }),
    );
    const titles = screen
      .getAllByRole('heading', { level: 4 })
      .map((heading) => heading.textContent?.replace(/\s+/g, ' ').trim());
    expect(titles).toEqual([
      'Mestre Laércio (2)',
      'Outros autores (1)',
      'Síntese do acervo (1)',
    ]);
    const mestre = screen.getByRole('list', { name: 'Mestre Laércio' });
    expect(
      [...mestre.querySelectorAll('button')].map((b) => b.dataset['docId']),
    ).toEqual(['raw/a.md', 'raw/c.md']);
    expect(
      screen.getByRole('button', { name: /O Caibalion/ }).textContent,
    ).toMatch(/Outros autores/);
  });

  it('keeps one list without badges for sources of one group or saved before authorship (KBC-020 AC-8)', async () => {
    await renderMessage(aTurn());
    expect(screen.queryAllByRole('heading', { level: 4 })).toEqual([]);
    expect(screen.queryByText(/Autoria:/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Os Princípios' })).toBeTruthy();
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
    ['CLI_MISSING', /não está disponível agora no servidor/],
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
    // No answer, so no "Resposta gerada por IA…" notice (KBC-029 review).
    expect(screen.queryByText(/Resposta gerada por IA/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tentar de novo' }));
    expect(view.retried).toHaveBeenCalledOnce();
  });

  it('offers "Tentar de novo" on a failed turn brought back from the history (KBC-029)', async () => {
    await renderMessage(
      aTurn({ phase: 'error', text: '', error: 'INTERNAL', restored: true }),
    );
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
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

describe('ResearchMessage on the app’s AI (KBC-022 AC-4, AC-5)', () => {
  it('names the model that answered, says it was free and how many researches are left', async () => {
    await renderMessage(
      aTurn({
        billing: 'free',
        usd: 0,
        model: 'fake/large:free',
        plan: 'house',
        remaining: 4,
      }),
    );
    const footer = document.querySelector('.footer')?.textContent ?? '';
    expect(footer).toContain('IA da aplicação (cedida pelo administrador)');
    expect(footer).toContain('Respondido por fake/large:free');
    expect(footer).toContain('Gratuito');
    expect(footer).toContain('Pesquisas restantes hoje: 4');
    expect(footer).not.toContain('Custo');
  });

  it('KBC-024: says the administrator’s subscription answered, and the researches left', async () => {
    await renderMessage(
      aTurn({
        billing: 'subscription',
        usd: 0,
        model: 'sonnet',
        plan: 'app-subscription',
        remaining: 2,
      }),
    );
    const footer = (
      document.querySelector('.footer')?.textContent ?? ''
    ).replace(/\s+/g, ' ');
    expect(footer).toContain(
      'IA da aplicação (assinatura do Claude do administrador)',
    );
    expect(footer).toContain('Incluído na assinatura do administrador');
    expect(footer).not.toContain('Incluído na sua assinatura');
    expect(footer).toContain('Pesquisas restantes hoje: 2');
  });

  it('KBC-027: says the administrator’s ChatGPT subscription answered', async () => {
    await renderMessage(
      aTurn({
        billing: 'subscription',
        usd: 0,
        model: 'gpt-5.5',
        plan: 'app-chatgpt-subscription',
        remaining: 3,
      }),
    );
    const footer = (
      document.querySelector('.footer')?.textContent ?? ''
    ).replace(/\s+/g, ' ');
    expect(footer).toContain(
      'IA da aplicação (assinatura do ChatGPT do administrador)',
    );
    expect(footer).toContain('Incluído na assinatura do administrador');
    expect(footer).toContain('Pesquisas restantes hoje: 3');
  });

  it('shows the cost of a paid fallback answer without the quota line for one’s own AI', async () => {
    await renderMessage(
      aTurn({
        billing: 'per-token',
        usd: 0.0042,
        plan: 'own',
        remaining: null,
      }),
    );
    const footer = document.querySelector('.footer')?.textContent ?? '';
    expect(footer).toContain('Custo');
    expect(footer).toContain('Sua IA');
    expect(footer).not.toContain('restantes');
  });

  it('offers one’s own AI when the quota is spent, and "Tentar de novo" for when it is back (KBC-061)', async () => {
    const { settings } = await renderMessage(
      aTurn({
        phase: 'error',
        text: '',
        error: 'HOUSE_QUOTA_EXHAUSTED',
        errorLimit: 5,
      }),
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'Suas pesquisas com IA de hoje acabaram (5 por dia)',
    );
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Conectar a minha IA' }),
    );
    expect(settings.openSettings).toHaveBeenCalledWith('ai');
  });

  it('explains a free capacity shortage and still lets the reader try again', async () => {
    await renderMessage(
      aTurn({ phase: 'error', text: '', error: 'AI_CAPACITY_EXHAUSTED' }),
    );
    expect(screen.getByRole('alert').textContent).toContain(
      'sem capacidade agora',
    );
    expect(screen.getByRole('button', { name: 'Tentar de novo' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Conectar a minha IA' }),
    ).toBeTruthy();
  });

  describe('exhaustive sweep (KBC-030)', () => {
    const progress = {
      status: 'running' as const,
      documents: 2555,
      needed: 1363,
      documentsDone: 412,
      batches: 80,
      batchesDone: 12,
      requests: 82,
      free: true,
      minutes: 5,
    };
    const coverage = {
      target: { authorship: 'mestre-laercio' as const },
      phrases: ['livro', 'obra'],
      documents: 2555,
      scanned: 2555,
      withHits: 412,
      read: 412,
      needed: 412,
      missing: 0,
      batches: 80,
    };
    const cursor = {
      plan: { target: {}, phrases: [], extract: 'livros' },
      totals: {
        documents: 2555,
        scanned: 640,
        withHits: null,
        read: 640,
        batches: 12,
      },
      findings: [],
    };
    const button = (name: string) => screen.queryByRole('button', { name });

    it('shows the estimate with its time, the free-model note and the progress while it sweeps', async () => {
      await renderMessage(
        aTurn({ phase: 'streaming', text: '', sweep: progress, steps: [] }),
      );
      expect(
        screen.getByRole('heading', { name: 'Varredura do conjunto inteiro' }),
      ).toBeTruthy();
      expect(
        screen.getByText(
          '2.555 documentos em ~80 lotes (~82 pedidos à IA). Leva pelo menos ~5 min.',
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(
          'Modelos gratuitos são menos rigorosos e mais lentos.',
        ),
      ).toBeTruthy();
      expect(screen.getByRole('status').textContent).toContain(
        'Lote 12 de 80 · a IA analisou 412 de 1.363 documentos',
      );
      // A fixed name: the numbers are announced once, by the status (MA-29).
      expect(
        screen.getByRole('progressbar', { name: 'Progresso da varredura' }),
      ).toBeTruthy();
      expect(button('Parar')).toBeTruthy();
    });

    it('states the most a paid model may cost before it sweeps', async () => {
      await renderMessage(
        aTurn({
          phase: 'streaming',
          text: '',
          sweep: { ...progress, free: false, minutes: undefined, usd: 0.42 },
          steps: [],
        }),
      );
      expect(screen.getByText(/Custo de no máximo US\$ 0,42/)).toBeTruthy();
    });

    it('renders the coverage with one word per count, and the summary, with no continue when complete', async () => {
      await renderMessage(aTurn({ coverage }));
      expect(
        screen.getByText(
          'Cobertura (medida pelo aplicativo): 2.555 documentos no conjunto · 2.555 conferidos pelas expressões · 412 com ocorrências · 412 analisados pela IA.',
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(/autoria Mestre Laércio; expressões: livro, obra/),
      ).toBeTruthy();
      expect(
        screen.getByText(/a IA analisou 412 de 412 documentos/),
      ).toBeTruthy();
      expect(button('Continuar varredura')).toBeNull();
    });

    it('says the counts add up earlier turns on a continuation', async () => {
      await renderMessage(
        aTurn({ coverage: { ...coverage, continued: true } }),
      );
      expect(
        screen.getByText(
          /412 analisados pela IA \(somando as varreduras anteriores\)\./,
        ),
      ).toBeTruthy();
    });

    it('says what was left and why, and offers to continue instead of starting over', async () => {
      await renderMessage(
        aTurn({
          interrupted: true,
          coverage: { ...coverage, read: 30, missing: 382, reason: 'requests' },
          cursor,
        }),
      );
      expect(screen.getByText('Varredura incompleta.')).toBeTruthy();
      expect(
        screen.getByText(
          /Faltaram 382 documentos para a IA analisar: o limite de pedidos desta pesquisa acabou\./,
        ),
      ).toBeTruthy();
      expect(button('Continuar varredura')).toBeTruthy();
      expect(button('Tentar de novo')).toBeNull();
    });

    it('says the answer was not written when the cap stopped it after the sweep', async () => {
      await renderMessage(
        aTurn({ text: '', coverage: { ...coverage, reason: 'spend' }, cursor }),
      );
      expect(
        screen.getByText(
          /A varredura terminou, mas a resposta não foi escrita: o teto de gasto do dia chegou\./,
        ),
      ).toBeTruthy();
      expect(button('Continuar varredura')).toBeTruthy();
    });

    it('emits continued, also on a turn brought back from the history, but only on the last one', async () => {
      const continued = vi.fn();
      await render(ResearchMessage, {
        providers: [
          provideZonelessChangeDetection(),
          { provide: SettingsStore, useValue: { openSettings: vi.fn() } },
        ],
        inputs: { turn: aTurn({ restored: true, cursor }), last: true },
        on: { continued },
      });
      fireEvent.click(
        screen.getByRole('button', { name: 'Continuar varredura' }),
      );
      expect(continued).toHaveBeenCalledTimes(1);
    });

    it('still marks an answer cut short after a complete sweep, with its partial cost (review round 3)', async () => {
      await renderMessage(aTurn({ interrupted: true, coverage }));
      expect(screen.getByText('(interrompida)')).toBeTruthy();
      expect(
        screen.getByText(
          'O custo do que já foi processado entra no gasto do dia.',
        ),
      ).toBeTruthy();
    });

    it('offers no continue on an earlier turn', async () => {
      await renderMessage(aTurn({ cursor }), false);
      expect(button('Continuar varredura')).toBeNull();
    });

    it('tells what was left when the reader stopped on this page, and what the AI analyzed', async () => {
      await renderMessage(
        aTurn({ interrupted: true, sweep: progress, cursor, text: '' }),
      );
      expect(screen.getByText('Varredura incompleta.')).toBeTruthy();
      expect(
        screen.getByText(
          /Faltaram 951 documentos para a IA analisar: você parou a pesquisa\./,
        ),
      ).toBeTruthy();
      expect(
        screen.getByText(/a IA analisou 412 de 1\.363 documentos/),
      ).toBeTruthy();
      // One explanation of the stop, not two; no AI notice without an answer.
      expect(
        screen.queryByText('Resposta interrompida antes de começar.'),
      ).toBeNull();
      expect(screen.queryByText(/Resposta gerada por IA/)).toBeNull();
      expect(button('Continuar varredura')).toBeTruthy();
    });
  });
});
