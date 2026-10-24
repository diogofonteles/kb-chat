import { provideZonelessChangeDetection } from '@angular/core';
import { render, screen } from '@testing-library/angular';
import { aResponse } from '../../testing/fixtures.js';
import type { ChatMessage } from './chat-message.js';
import { ResultMessage } from './result-message.js';

const base: ChatMessage = {
  id: 1,
  topic: 'hermetismo',
  question: 'xyzzy',
  mode: 'semantic',
  status: 'done',
  response: aResponse([]),
  error: null,
};

describe('ResultMessage', () => {
  it('does not offer a semantic search when the search already was semantic', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: { message: base },
    });
    expect(screen.getByText('Nada encontrado para "xyzzy".')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: 'Buscar por significado' }),
    ).toBeNull();
  });

  it('shows an empty list for a finished message without a response', async () => {
    await render(ResultMessage, {
      providers: [provideZonelessChangeDetection()],
      inputs: { message: { ...base, mode: 'all', response: null } },
    });
    expect(
      screen.getByRole('button', { name: 'Buscar por significado' }),
    ).toBeTruthy();
  });
});
