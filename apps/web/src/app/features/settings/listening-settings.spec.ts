import { provideHttpClient } from '@angular/common/http';
import {
  HttpTestingController,
  provideHttpClientTesting,
} from '@angular/common/http/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { fireEvent, render, screen } from '@testing-library/angular';
import { MEDIA_ELEMENT_FACTORY } from '@core/media/media-engine.js';
import { fakeMediaElement } from '../../testing/fake-media-element.js';
import { ListeningSettings } from './listening-settings.js';

const PREFERENCES_URL = '/api/v1/media/preferences';

async function openSettings() {
  const media = fakeMediaElement('audio');
  await render(ListeningSettings, {
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: MEDIA_ELEMENT_FACTORY, useValue: () => media.element },
    ],
  });
  return TestBed.inject(HttpTestingController);
}

const stopSwitch = () =>
  screen.getByRole('switch', {
    name: 'Parar no fim do trecho',
  }) as HTMLInputElement;

describe('ListeningSettings (KBC-160 FR-4)', () => {
  it('shows the account\'s "Parar no fim do trecho" under Escuta', async () => {
    const http = await openSettings();
    expect(screen.getByRole('region', { name: 'Escuta' })).toBeTruthy();
    expect(stopSwitch().checked).toBe(true);
    http.expectOne({ method: 'GET', url: PREFERENCES_URL }).flush({
      speed: 1,
      showRemaining: true,
      skipBackSec: 15,
      skipForwardSec: 30,
      skipSilences: false,
      wordHighlight: true,
      stopAtPassageEnd: false,
    });
    await vi.waitFor(() => expect(stopSwitch().checked).toBe(false));
    http.verify();
  });

  it('saves the change to the account', async () => {
    const http = await openSettings();
    fireEvent.click(stopSwitch());
    expect(
      http.expectOne({ method: 'PUT', url: PREFERENCES_URL }).request.body,
    ).toEqual({ stopAtPassageEnd: false });
  });
});
