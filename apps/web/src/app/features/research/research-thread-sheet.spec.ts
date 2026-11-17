import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen, within } from '@testing-library/angular';
import { ChatStore } from '@features/chat/chat-store.js';
import { SettingsStore } from '@features/settings/settings-store.js';
import { MEDIA_ELEMENT_FACTORY } from '@core/media/media-engine.js';
import { fakeMediaElement } from '../../testing/fake-media-element.js';
import { ResearchThread } from './research-thread.js';
import { startTurn, type ResearchTurn } from './research-turn.js';

const TRACK = {
  n: 2,
  id: 'raw/media/r/t.md',
  title: 'O que é o ritmo?',
  media: {
    mediaId: '0b9c1f7e-1111-4a2b-8c3d-000000000001',
    kind: 'track' as const,
    recordingTitle: 'Palestra de 12/03/2017',
    durationMs: 508_000,
    confidence: 'normal' as const,
  },
  passages: [{ at: '0:41', startMs: 41_300, endMs: 70_000 }],
};

const TURN: ResearchTurn = {
  ...startTurn(1, 'o que é o ritmo?'),
  phase: 'done',
  text: 'Um método [1]. O pêndulo [2@0:41].',
  sources: [{ n: 1, id: 'raw/a.md', title: 'Os Princípios' }, TRACK],
};

function phone(matches: boolean): void {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  });
}

async function renderThread() {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  const trackOpened = vi.fn();
  const opened = vi.fn();
  await render(ResearchThread, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      provideRouter([]),
      { provide: SettingsStore, useValue: { openSettings: vi.fn() } },
      {
        provide: ChatStore,
        useValue: {
          topicSlug: signal('hermetismo'),
          topicList: signal([]),
          openTrack: signal(null),
          openSource: vi.fn(),
          leaveSources: vi.fn(),
        },
      },
      {
        provide: MEDIA_ELEMENT_FACTORY,
        useValue: () => fakeMediaElement('audio').element,
      },
    ],
    inputs: { turns: [TURN] },
    on: { trackOpened, opened },
  });
  return { trackOpened, opened };
}

const audioCitation = () =>
  screen.getByRole('link', {
    name: 'Fonte 2, faixa O que é o ritmo?, aos 41 segundos',
  });

describe('ResearchThread: the audio source (KBC-150 items 8 and 9)', () => {
  afterEach(() => Reflect.deleteProperty(window, 'matchMedia'));

  it('on a desktop, a track goes to the page’s panel with the answer’s sources', async () => {
    phone(false);
    const { trackOpened } = await renderThread();
    fireEvent.click(audioCitation());
    expect(trackOpened).toHaveBeenCalledWith(
      expect.objectContaining({
        source: TRACK,
        at: '0:41',
        sources: TURN.sources,
        question: 'o que é o ritmo?',
      }),
    );
  });

  it('on a phone, a track opens in the reading sheet, a tab per source, the audio one with the wave', async () => {
    phone(true);
    const { trackOpened } = await renderThread();
    fireEvent.click(audioCitation());
    expect(trackOpened).not.toHaveBeenCalled();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent?.trim())).toEqual([
      'Fonte 1',
      'Fonte 2',
    ]);
    expect(tabs[1]?.getAttribute('aria-selected')).toBe('true');
    expect(tabs[1]?.querySelector('ui-icon')).toBeTruthy();
    expect(tabs[0]?.querySelector('ui-icon')).toBeNull();
    const panel = screen.getByRole('tabpanel');
    expect(panel.tagName).toBe('APP-TRACK-PASSAGE-PANEL');
    expect(
      within(panel).getByRole('heading', { name: 'O que é o ritmo?' }),
    ).toBeTruthy();
  });

  it('a text source keeps the document panel in the sheet (the audio rule, item 9)', async () => {
    phone(true);
    const { opened } = await renderThread();
    fireEvent.click(screen.getByRole('link', { name: /^Fonte 1:/ }));
    expect(opened).not.toHaveBeenCalled();
    const panel = await screen.findByRole('tabpanel');
    expect(panel.tagName).toBe('APP-DOCUMENT-PANEL');
    // The audio tab takes the sheet to the track.
    fireEvent.click(screen.getAllByRole('tab')[1] as HTMLElement);
    expect((await screen.findByRole('tabpanel')).tagName).toBe(
      'APP-TRACK-PASSAGE-PANEL',
    );
  });
});
