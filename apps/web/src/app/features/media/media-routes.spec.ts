import {
  Component,
  provideZonelessChangeDetection,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { Feature } from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { mediaEnabled } from './media-routes.js';

@Component({ template: 'media page' })
class MediaStub {}

async function landingFor(
  me: { media: boolean } | null,
  features: Feature[],
  state = signal<{ kind: string }>({ kind: 'signed-in' }),
) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideRouter([
        { path: 'midia', canMatch: [mediaEnabled], component: MediaStub },
        { path: '', children: [] },
      ]),
      {
        provide: SessionStore,
        useValue: {
          state,
          me: signal(me),
          can: (feature: Feature) => features.includes(feature),
        },
      },
    ],
  });
  const harness = await RouterTestingHarness.create();
  await harness.navigateByUrl('/midia');
  return TestBed.inject(Router).url;
}

describe('mediaEnabled (every feature granted per person)', () => {
  it('opens the media pages with the library on and "Ouvir mídia"', async () => {
    expect(await landingFor({ media: true }, ['media'])).toBe('/midia');
  });

  it('sends home without "Ouvir mídia"', async () => {
    expect(await landingFor({ media: true }, ['search'])).toBe('/');
  });

  it('sends home when the server has media off', async () => {
    expect(await landingFor({ media: false }, ['media'])).toBe('/');
  });

  it('waits for the session before deciding (a link opened directly)', async () => {
    const state = signal<{ kind: string }>({ kind: 'loading' });
    const landing = landingFor({ media: true }, ['media'], state);
    setTimeout(() => state.set({ kind: 'signed-in' }), 10);
    expect(await landing).toBe('/midia');
  });
});
