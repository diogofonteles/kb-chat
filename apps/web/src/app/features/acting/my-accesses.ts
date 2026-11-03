import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ActAsApi } from '@core/auth/act-as-api.js';

/**
 * "Acessos à sua conta" (KBC-060 FR-7, BR-7): each time a master used the app as this
 * person — who, when, how long, why and how many changes.
 */
@Component({
  selector: 'app-my-accesses',
  imports: [DatePipe],
  template: `
    <p class="hint" i18n="@@accesses.explain">
      Um master pode usar o app como você para ajudar com um problema. Cada vez
      fica registrada aqui.
    </p>
    @if (accesses.error()) {
      <p role="alert" i18n="@@accesses.failed">
        Não consegui carregar os acessos.
      </p>
    } @else if (accesses.hasValue()) {
      @if (accesses.value().length === 0) {
        <p class="muted" i18n="@@accesses.none">Ninguém entrou na sua conta.</p>
      } @else {
        <ul class="list">
          @for (access of accesses.value(); track access.startedAt) {
            <li class="item">
              <p class="who">{{ access.actorName || access.actorEmail }}</p>
              <p class="when">
                {{ access.startedAt | date: 'dd/MM/yyyy HH:mm' }}
                @if (access.endedAt; as ended) {
                  – {{ ended | date: 'HH:mm' }}
                } @else {
                  <span i18n="@@accesses.ongoing">(agora)</span>
                }
                ·
                <ng-container i18n="@@accesses.writes">{access.writes, plural,
                  =0 {nenhuma alteração}
                  =1 {1 alteração}
                  other {{{access.writes}} alterações}
                }</ng-container>
              </p>
              <p class="reason">
                <span i18n="@@accesses.reason">Motivo:</span>
                {{ access.reason }}
              </p>
            </li>
          }
        </ul>
      }
    } @else {
      <p class="muted" i18n="@@accesses.loading">Carregando…</p>
    }
  `,
  styleUrl: './acting-lists.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MyAccesses {
  private readonly api = inject(ActAsApi);
  protected readonly accesses = rxResource({
    stream: () => this.api.accesses(),
  });
}
