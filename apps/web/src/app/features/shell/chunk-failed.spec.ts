import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { fireEvent, render, screen } from '@testing-library/angular';
import { AppVersion } from '@core/app-version/app-version.js';
import { ChunkFailed } from './chunk-failed.js';

describe('ChunkFailed (KBC-123 AC-5)', () => {
  async function renderFailed(quiet: boolean) {
    const version = { check: vi.fn(), update: vi.fn() };
    await render(ChunkFailed, {
      providers: [
        provideZonelessChangeDetection(),
        provideRouter([]),
        { provide: AppVersion, useValue: version },
      ],
      inputs: { quiet },
    });
    return version;
  }

  it('asks for the version as a deferred page fails to load, and offers to reload', async () => {
    const version = await renderFailed(false);
    expect(version.check).toHaveBeenCalledWith('chunk', '/');
    expect(screen.getByRole('alert').textContent).toContain(
      'Não consegui abrir esta página.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Recarregar' }));
    expect(version.update).toHaveBeenCalledTimes(1);
  });

  it('shows nothing for a background block (settings), but still asks', async () => {
    const version = await renderFailed(true);
    expect(version.check).toHaveBeenCalledWith('chunk', '/');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
