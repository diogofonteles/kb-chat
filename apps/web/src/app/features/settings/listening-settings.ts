import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { ListeningPreferences } from '@core/media/listening-preferences.js';
import { UiSettingRow } from '@ui/index.js';

/**
 * Configurações › Preferências › Escuta (KBC-160 FR-4): "Parar no fim do trecho", the same
 * account choice as the switch on the audio source's passage card.
 */
@Component({
  selector: 'app-listening-settings',
  imports: [UiSettingRow],
  template: `
    <section class="group" aria-labelledby="listening-settings-title">
      <h3
        id="listening-settings-title"
        class="group-title"
        i18n="@@prefs.listening"
      >
        Escuta
      </h3>
      <ui-setting-row
        i18n-label="@@prefs.stopAtPassageEnd"
        label="Parar no fim do trecho"
        for="pref-stop-at-passage-end"
        descriptionId="pref-stop-at-passage-end-hint"
        i18n-description="@@prefs.stopAtPassageEndHint"
        description="Ao ouvir um trecho citado numa resposta, o áudio pausa no fim dele."
      >
        <input
          #stopBox
          id="pref-stop-at-passage-end"
          type="checkbox"
          role="switch"
          class="ui-switch"
          [checked]="stopAtPassageEnd()"
          (change)="setStopAtPassageEnd(stopBox.checked)"
          aria-describedby="pref-stop-at-passage-end-hint"
        />
      </ui-setting-row>
    </section>
  `,
  styleUrl: './settings-form.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ListeningSettings {
  private readonly listening = inject(ListeningPreferences);

  protected readonly stopAtPassageEnd = computed(
    () => this.listening.value().stopAtPassageEnd,
  );

  constructor() {
    this.listening.load();
  }

  protected setStopAtPassageEnd(on: boolean): void {
    this.listening.setStopAtPassageEnd(on);
  }
}
