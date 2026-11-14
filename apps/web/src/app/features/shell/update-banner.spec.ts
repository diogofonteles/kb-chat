import { provideZonelessChangeDetection, signal } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { AppVersion } from '@core/app-version/app-version.js';
import { UpdateBanner } from './update-banner.js';

describe('UpdateBanner (KBC-123 AC-2)', () => {
  async function renderBanner(available: boolean) {
    const version = {
      updateAvailable: signal(available),
      update: vi.fn(),
      dismiss: vi.fn(),
    };
    const view = await render(UpdateBanner, {
      providers: [
        provideZonelessChangeDetection(),
        { provide: AppVersion, useValue: version },
      ],
    });
    return { view, version };
  }

  it('offers "Atualizar" in a status region, which reloads the app', async () => {
    const { version } = await renderBanner(true);
    expect(screen.getByRole('status').textContent).toContain(
      'Nova versão disponível.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Atualizar' }));
    expect(version.update).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Agora não' }));
    expect(version.dismiss).toHaveBeenCalledTimes(1);
  });

  it('shows nothing while the app is up to date, and says it once it is not', async () => {
    const { view, version } = await renderBanner(false);
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    version.updateAvailable.set(true);
    await view.fixture.whenStable();
    expect(screen.getByRole('status').textContent).toContain(
      'Nova versão disponível.',
    );
    expect(screen.getByRole('button', { name: 'Atualizar' })).toBeTruthy();
  });
});
