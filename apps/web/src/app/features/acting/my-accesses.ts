import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { ActAsApi } from '@core/auth/act-as-api.js';
import { UiAvatar, UiBanner, UiEmptyState, UiPill } from '@ui/index.js';

/**
 * "Acessos à sua conta" (KBC-060 FR-7, BR-7): each time a master used the app as this
 * person — who, when, how long, why and how many changes.
 */
@Component({
  selector: 'app-my-accesses',
  imports: [DatePipe, UiAvatar, UiBanner, UiEmptyState, UiPill],
  template: `
    <p class="hint" i18n="@@accesses.explain">
      Um master pode usar o app como você para ajudar com um problema. Cada vez
      fica registrada aqui.
    </p>
    @if (accesses.error()) {
      <ui-banner tone="err" role="alert">
        <p i18n="@@accesses.failed">Não consegui carregar os acessos.</p>
      </ui-banner>
    } @else if (accesses.hasValue()) {
      @if (accesses.value().length === 0) {
        <ui-empty-state
          icon="eye"
          i18n-title="@@accesses.none"
          title="Ninguém entrou na sua conta."
        />
      } @else {
        <div class="table-head" aria-hidden="true">
          <span i18n="@@accesses.colWho">Quem</span>
          <span i18n="@@accesses.colWhen">Quando</span>
          <span i18n="@@accesses.colWrites">Alterações</span>
          <span i18n="@@accesses.colReason">Motivo</span>
        </div>
        <ul class="list table">
          @for (access of accesses.value(); track access.startedAt) {
            <li class="item row access">
              <p class="who">
                <ui-avatar
                  [name]="access.actorName || access.actorEmail"
                  [size]="32"
                />
                <strong>{{ access.actorName || access.actorEmail }}</strong>
              </p>
              <p class="when">
                {{ access.startedAt | date: 'dd/MM/yyyy HH:mm' }}
                @if (access.endedAt; as ended) {
                  – {{ ended | date: 'HH:mm' }}
                } @else {
                  <span i18n="@@accesses.ongoing">(agora)</span>
                }
              </p>
              <p class="writes">
                <ui-pill [tone]="access.writes > 0 ? 'warn' : 'muted'"
                  ><ng-container
                    i18n="@@accesses.writes"
                    >{access.writes, plural,
                      =0 {nenhuma alteração}
                      =1 {1 alteração}
                      other {{{access.writes}} alterações}
                    }</ng-container
                  ></ui-pill
                >
              </p>
              <p class="reason">
                <span class="reason-label" i18n="@@accesses.reason"
                  >Motivo:</span
                >
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
