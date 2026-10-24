import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SettingsHost } from '@features/settings/settings-host.js';

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, SettingsHost],
  // Settings load in their own chunk, right after the first paint (keeps the initial bundle small).
  template: '<router-outlet />@defer (on immediate) {<app-settings-host />}',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {}
