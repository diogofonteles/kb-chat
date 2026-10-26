import { bootstrapApplication } from '@angular/platform-browser';
import { App } from './app/app.js';
import { appConfig } from './app/app.config.js';

bootstrapApplication(App, appConfig).catch((err: unknown) =>
  console.error(err),
);
