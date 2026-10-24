import { provideZonelessChangeDetection } from '@angular/core';
import { provideRouter } from '@angular/router';
import { render } from '@testing-library/angular';
import { App } from './app.js';
import { routes } from './app.routes.js';

describe('App', () => {
  it('renders the router outlet with the chat route registered', async () => {
    const { container } = await render(App, {
      providers: [provideZonelessChangeDetection(), provideRouter([])],
    });
    expect(container.querySelector('router-outlet')).toBeTruthy();
    expect(routes[0]?.path).toBe('');
  });
});
