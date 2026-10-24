import { registerLocaleData } from '@angular/common';
import { provideHttpClient, withFetch } from '@angular/common/http';
import localePt from '@angular/common/locales/pt';
import {
  LOCALE_ID,
  provideZonelessChangeDetection,
  type ApplicationConfig,
} from '@angular/core';
import { provideRouter } from '@angular/router';
import { routes } from './app.routes.js';

// pt-BR is the UI locale (vírgula decimal, "1.234 documentos").
registerLocaleData(localePt, 'pt-BR');

export const appConfig: ApplicationConfig = {
  providers: [
    provideZonelessChangeDetection(),
    provideRouter(routes),
    provideHttpClient(withFetch()),
    { provide: LOCALE_ID, useValue: 'pt-BR' },
  ],
};
