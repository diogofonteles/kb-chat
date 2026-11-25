import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import {
  ContentSender,
  type ContentSend,
  type SendPhase,
} from './content-sender.js';
import { ContentSends } from './content-sends.js';

const send = (key: number, phase: SendPhase): ContentSend => ({
  key,
  name: `a-${key}.pdf`,
  source: { kind: 'url', url: `https://example.org/${key}` },
  target: {
    topic: 'hermetismo',
    level: null,
    batch: { id: crypto.randomUUID(), capUsd: 0.5 },
  },
  phase,
});

const ALREADY: SendPhase = {
  kind: 'duplicate',
  document: null,
  onItsWay: false,
};
const FAILED: SendPhase = { kind: 'error', message: 'Não deu.' };

async function renderSends(phases: readonly SendPhase[]) {
  const sends = signal(phases.map((phase, at) => send(at, phase)));
  const of = (...kinds: readonly SendPhase['kind'][]) =>
    sends().filter(({ phase }) => kinds.includes(phase.kind)).length;
  const summary = signal({
    total: phases.length,
    active: of('waiting', 'sending', 'hashing', 'paused'),
    sent: of('sent'),
    already: of('duplicate'),
    failed: of('error'),
    givenUp: 0,
  });
  const again = () =>
    sends.update((all) =>
      all.map((one) =>
        one.phase.kind === 'error'
          ? { ...one, phase: { kind: 'waiting' } }
          : one,
      ),
    );
  const sender = { sends, summary, retry: again, retryFailed: again };
  const view = await render(ContentSends, {
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([]),
      { provide: ContentSender, useValue: sender },
    ],
  });
  return { ...view, sender, summary };
}

describe('Enviados agora (KBC-184)', () => {
  it('says all came only when all came', async () => {
    await renderSends([{ kind: 'sent' }, { kind: 'sent' }]);
    expect(screen.getByText('Tudo o que você incluiu chegou')).toBeTruthy();
  });

  it('what was here, or on its way by another person, is not said to have come', async () => {
    await renderSends([ALREADY]);
    expect(screen.queryByText('Tudo o que você incluiu chegou')).toBeNull();
    expect(screen.getByText('Nada novo para enviar')).toBeTruthy();
    expect(screen.getByText(/1 já estava aqui ou a caminho/)).toBeTruthy();
    expect(screen.queryByText(/O Mac converte/)).toBeNull();
  });

  it('with both, it says which is which', async () => {
    await renderSends([{ kind: 'sent' }, ALREADY, ALREADY]);
    expect(screen.getByText('O que faltava chegou')).toBeTruthy();
    expect(screen.getByText(/2 já estavam aqui ou a caminho/)).toBeTruthy();
    expect(screen.getByText(/O Mac converte/)).toBeTruthy();
  });

  it.each(['Tentar de novo (1)', 'Tentar de novo'])(
    '"%s" goes away when pressed: the focus goes to the list (WCAG 2.4.3)',
    async (name) => {
      const { fixture, summary } = await renderSends([FAILED]);
      const button = screen.getByRole('button', { name });
      button.focus();
      fireEvent.click(button);
      summary.update((before) => ({ ...before, active: 1, failed: 0 }));
      await fixture.whenStable();
      expect(document.activeElement?.textContent).toContain('Enviados agora');
    },
  );
});
