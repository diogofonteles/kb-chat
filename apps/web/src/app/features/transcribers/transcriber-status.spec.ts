import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import type {
  TranscriberStatusItem,
  TranscriberStatusOverview,
} from '@kb-chat/contracts';
import { TranscriberStatus } from './transcriber-status.js';
import { TranscriberStatusStore } from './transcriber-status-store.js';

const STATUS = '/api/v1/media/transcribers/status';
const START = '/api/v1/media/transcribers/local/start';
const MAC = '33333333-3333-4333-8333-333333333333';

const report = (
  over: Partial<NonNullable<TranscriberStatusItem['report']>> = {},
): NonNullable<TranscriberStatusItem['report']> => ({
  state: 'working',
  detail: null,
  version: '0.1.0 (2026-10-28.1)',
  kinds: ['transcribe', 'kb-publish'],
  startedAt: '2026-11-09T12:00:00.000Z',
  currentJob: {
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'transcribe',
    label: 'Aula 3',
    startedAt: '2026-11-09T12:01:00.000Z',
    progress: 40,
  },
  recentJobs: [
    {
      id: '22222222-2222-4222-8222-222222222222',
      kind: 'kb-publish',
      label: 'publicando udv (3 documentos)',
      outcome: 'failed',
      finishedAt: '2026-11-09T11:59:00.000Z',
      detail: 'kb classify: OpenRouter 502',
    },
  ],
  lastError: {
    at: '2026-11-09T11:59:00.000Z',
    message: 'kb classify: OpenRouter 502',
  },
  counts: { done: 2, failed: 1 },
  vaultPath: '/Users/owner/dev/personal/hermetismo',
  kbVersion: '0.0.12',
  receivedAt: '2026-11-09T12:02:00.000Z',
  ...over,
});

const anItem = (
  over: Partial<TranscriberStatusItem> = {},
): TranscriberStatusItem => ({
  id: MAC,
  name: 'Mac do dono',
  kinds: ['transcribe', 'kb-publish'],
  lastSeenAt: '2026-11-09T12:02:00.000Z',
  state: 'working',
  report: report(),
  ...over,
});

const anOverview = (
  over: Partial<TranscriberStatusOverview> = {},
): TranscriberStatusOverview => ({
  items: [anItem()],
  kbQueue: { waiting: 3 },
  start: {
    label: 'br.com.nova-alexandria.transcriber',
    startCommand:
      'launchctl kickstart -k gui/$(id -u)/br.com.nova-alexandria.transcriber',
    canStartHere: false,
  },
  attention: { blocked: [], stuck: null },
  ...over,
});

async function renderIt(
  overview: TranscriberStatusOverview,
  transcriberId: string | null = null,
) {
  const result = await render(TranscriberStatus, {
    inputs: { transcriberId },
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      TranscriberStatusStore,
    ],
  });
  const http = TestBed.inject(HttpTestingController);
  http.expectOne(STATUS).flush(overview);
  await result.fixture.whenStable();
  return { ...result, http };
}

describe('TranscriberStatus (KBC-114 AC-12, AC-13, AC-14)', () => {
  it('review PD-15: a status that could not be read says so, and tries again', async () => {
    const result = await render(TranscriberStatus, {
      inputs: { transcriberId: null },
      providers: [
        provideZonelessChangeDetection(),
        provideHttpClient(),
        provideHttpClientTesting(),
        TranscriberStatusStore,
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    http
      .expectOne(STATUS)
      .flush({}, { status: 500, statusText: 'Internal Server Error' });
    await result.fixture.whenStable();
    const chip = screen.getByRole<HTMLButtonElement>('button', {
      name: 'Transcritor: status indisponível',
    });
    expect(chip.disabled).toBe(false);
    expect(chip.textContent).toContain('⚠');
    expect(screen.queryByText('Nenhum transcritor pareado')).toBeNull();
    fireEvent.click(chip);
    http.expectOne(STATUS).flush(anOverview());
    await result.fixture.whenStable();
    expect(
      screen.getByRole('button', { name: /Transcritor: Trabalhando/ }),
    ).toBeTruthy();
  });

  it('QA F-1: says what work waits that no transcriber does, and what to mark', async () => {
    const { http, fixture } = await renderIt(
      anOverview({
        items: [anItem({ state: 'offline', report: null })],
        attention: {
          blocked: [{ kind: 'diarize', ready: 2, reason: 'not-marked' }],
          stuck: null,
        },
      }),
    );
    expect(
      screen.getByRole('button', { name: 'Transcritor: trabalho parado' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /trabalho parado/ }));
    http.expectOne(STATUS).flush(
      anOverview({
        items: [anItem({ state: 'offline', report: null })],
        attention: {
          blocked: [{ kind: 'diarize', ready: 2, reason: 'not-marked' }],
          stuck: null,
        },
      }),
    );
    await fixture.whenStable();
    expect(screen.getByRole('dialog').textContent).toContain(
      '2 trabalhos de Vozes esperam: nenhum transcritor está marcado para isso. Marque "Separa vozes" em Transcritores.',
    );
  });

  it('QA F-1: says when it was started and took nothing, and that it waits for the queue to change', async () => {
    const stuck = anOverview({
      items: [anItem({ state: 'offline', report: null })],
      attention: {
        blocked: [],
        stuck: { ready: 1, reason: 'took-nothing', detail: null },
      },
    });
    const { http, fixture } = await renderIt(stuck);
    fireEvent.click(screen.getByRole('button', { name: /trabalho parado/ }));
    http.expectOne(STATUS).flush(stuck);
    await fixture.whenStable();
    expect(screen.getByRole('dialog').textContent).toContain(
      'O transcritor ligou e não pegou o trabalho da fila (1)',
    );
  });

  /** Opens the details of the summary chip over this overview. */
  async function detailsOf(overview: TranscriberStatusOverview) {
    const { http, fixture } = await renderIt(overview);
    fireEvent.click(
      screen.getByRole('button', { name: /^Transcritor|^Nenhum/ }),
    );
    http.expectOne(STATUS).flush(overview);
    await fixture.whenStable();
    return screen.getByRole('dialog');
  }

  it('review r2 S-2: marked but not installed never says to mark it again', async () => {
    const dialog = await detailsOf(
      anOverview({
        items: [anItem({ state: 'offline', report: null })],
        attention: {
          blocked: [{ kind: 'diarize', ready: 2, reason: 'not-installed' }],
          stuck: null,
        },
      }),
    );
    expect(dialog.textContent).toContain(
      'o Mac não conseguiu carregar o componente de separar vozes',
    );
    expect(dialog.textContent).not.toContain('Marque "Separa vozes"');
  });

  it('QA r2 (1): with no transcriber paired it says to pair, and offers nothing to turn on', async () => {
    const dialog = await detailsOf(
      anOverview({
        items: [],
        start: { ...anOverview().start, canStartHere: true },
        attention: {
          blocked: [{ kind: 'transcribe', ready: 1, reason: 'none-paired' }],
          stuck: null,
        },
      }),
    );
    expect(dialog.textContent).toContain('nenhum transcritor pareado');
    expect(dialog.textContent).not.toContain('comando abaixo');
    expect(dialog.textContent).not.toContain('liga sozinho assim');
    expect(
      within(dialog).queryByRole('button', { name: 'Ligar transcritor' }),
    ).toBeNull();
  });

  it('QA r2 (1): with work blocked it does not promise it turns on by itself', async () => {
    const dialog = await detailsOf(
      anOverview({
        items: [anItem({ state: 'offline', report: null })],
        start: { ...anOverview().start, canStartHere: true },
        attention: {
          blocked: [{ kind: 'transcribe', ready: 1, reason: 'not-marked' }],
          stuck: null,
        },
      }),
    );
    expect(dialog.textContent).not.toContain('liga sozinho assim');
    expect(
      within(dialog).getByRole('button', { name: 'Ligar transcritor' }),
    ).toBeTruthy();
  });

  it('QA r2 (2): a start that failed says what macOS answered', async () => {
    const dialog = await detailsOf(
      anOverview({
        items: [anItem({ state: 'offline', report: null })],
        attention: {
          blocked: [],
          stuck: {
            ready: 1,
            reason: 'start-failed',
            detail: 'Could not find service',
          },
        },
      }),
    );
    expect(dialog.textContent).toContain(
      'O macOS não conseguiu ligar o transcritor: Could not find service',
    );
    expect(dialog.textContent).not.toContain('não pegou');
  });

  it('review r2 N-2: documents held by the media ceiling say so', async () => {
    const dialog = await detailsOf(
      anOverview({
        items: [anItem({ state: 'offline', report: null })],
        attention: {
          blocked: [{ kind: 'kb-publish', ready: 4, reason: 'monthly-cap' }],
          stuck: null,
        },
      }),
    );
    expect(dialog.textContent).toContain('teto mensal da mídia');
  });

  it('says since when it is on, or off (AC-16)', async () => {
    await renderIt(
      anOverview({
        items: [
          anItem({
            state: 'idle',
            report: report({ state: 'idle', currentJob: null }),
          }),
          anItem({
            id: '44444444-4444-4444-8444-444444444444',
            name: 'Outro',
            state: 'offline',
          }),
        ],
      }),
      MAC,
    );
    expect(
      screen.getByRole('button', { name: /^Transcritor: Ligado desde \d/ }),
    ).toBeTruthy();
  });

  it('says in words what the transcriber does, with a sign beside them', async () => {
    await renderIt(anOverview(), MAC);
    const chip = screen.getByRole('button', {
      name: /Transcritor: Trabalhando, transcrevendo Aula 3 \(40%\)/,
    });
    expect(chip.textContent).toContain('↻');
  });

  it('opens the details on a click: job, recent jobs, last error, last seen, vault and kb', async () => {
    const { http, fixture } = await renderIt(anOverview(), MAC);
    fireEvent.click(screen.getByRole('button', { name: /Transcritor:/ }));
    http.expectOne(STATUS).flush(anOverview());
    await fixture.whenStable();
    const dialog = screen.getByRole('dialog', {
      name: 'Transcritor "Mac do dono"',
    });
    const inside = within(dialog);
    expect(inside.getByText('transcrevendo Aula 3 (40%)')).toBeTruthy();
    expect(
      inside.getByText(/OpenRouter 502/, { selector: '.error-line' }),
    ).toBeTruthy();
    expect(
      inside.getByText('/Users/owner/dev/personal/hermetismo'),
    ).toBeTruthy();
    expect(inside.getByText('0.0.12')).toBeTruthy();
    expect(inside.getByText('3 documentos')).toBeTruthy();
    expect(dialog.textContent).toContain('falhou');
    // On, it does not say how to turn it on.
    expect(inside.queryByText('Como ligar')).toBeNull();
    fireEvent.click(inside.getByRole('button', { name: 'Fechar' }));
    expect(dialog.hasAttribute('open')).toBe(false);
  });

  it('off: says so and gives the exact commands, without "Ligar transcritor" in production', async () => {
    const off = anOverview({
      items: [anItem({ state: 'offline' })],
    });
    const { http, fixture } = await renderIt(off, MAC);
    fireEvent.click(
      screen.getByRole('button', { name: /^Transcritor: Desligado desde / }),
    );
    http.expectOne(STATUS).flush(off);
    await fixture.whenStable();
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText('Como ligar')).toBeTruthy();
    expect(
      dialog.getByText(
        'launchctl kickstart -k gui/$(id -u)/br.com.nova-alexandria.transcriber',
      ),
    ).toBeTruthy();
    // The owner never runs a uv command (KBC-114): the service installs and starts itself.
    expect(dialog.queryByText(/uv run|service install/)).toBeNull();
    expect(dialog.getByText(/liga sozinho com ele/)).toBeTruthy();
    expect(
      dialog.queryByRole('button', { name: 'Ligar transcritor' }),
    ).toBeNull();
  });

  it('on the same Mac, "Ligar transcritor" asks once and says what came back', async () => {
    const off = anOverview({
      items: [anItem({ state: 'offline' })],
      start: { ...anOverview().start, canStartHere: true },
    });
    const { http, fixture } = await renderIt(off, MAC);
    fireEvent.click(screen.getByRole('button', { name: /Desligado/ }));
    http.expectOne(STATUS).flush(off);
    await fixture.whenStable();
    const button = screen.getByRole('button', { name: 'Ligar transcritor' });
    button.click();
    button.click();
    const asked = http.match(START);
    expect(asked).toHaveLength(1);
    asked[0]?.flush({ ok: true, detail: 'transcriber started' });
    TestBed.tick();
    http.expectOne(STATUS).flush(anOverview());
    await fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Pedido enviado ao macOS',
    );
  });

  it('without a transcriber paired, says so and points to pairing', async () => {
    const { http, fixture } = await renderIt(anOverview({ items: [] }));
    fireEvent.click(
      screen.getByRole('button', { name: 'Nenhum transcritor pareado' }),
    );
    http.expectOne(STATUS).flush(anOverview({ items: [] }));
    await fixture.whenStable();
    expect(
      screen.getByText(/Pareie o Mac em Configurações → Transcritores/),
    ).toBeTruthy();
  });

  it('speaks for the transcriber that publishes when none is named', async () => {
    const other = anItem({
      id: '44444444-4444-4444-8444-444444444444',
      name: 'Mac antigo',
      kinds: ['transcribe'],
      state: 'idle',
      report: null,
    });
    await renderIt(
      anOverview({
        items: [
          other,
          anItem({
            state: 'waiting',
            report: report({
              state: 'waiting',
              detail: 'trava do vault ocupada por outra publicação',
              currentJob: null,
            }),
          }),
        ],
      }),
    );
    expect(
      screen.getByRole('button', {
        name: 'Transcritor: Aguardando, trava do vault ocupada por outra publicação',
      }),
    ).toBeTruthy();
  });
});
