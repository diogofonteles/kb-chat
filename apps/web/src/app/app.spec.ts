import { provideZonelessChangeDetection } from '@angular/core';
import { DeferBlockBehavior } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { render, screen } from '@testing-library/angular';
import { App } from './app.js';
import { routes } from './app.routes.js';

describe('App', () => {
  it('shows "Carregando…" until the session shell loads, with the chat route registered', async () => {
    await render(App, {
      providers: [provideZonelessChangeDetection(), provideRouter([])],
      deferBlockBehavior: DeferBlockBehavior.Manual,
    });
    expect(screen.getByRole('status').textContent).toContain('Carregando');
    expect(routes[0]?.path).toBe('');
  });
});
