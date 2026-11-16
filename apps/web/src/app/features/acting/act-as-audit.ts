import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import type { ActAsAuditEntry } from '@kb-chat/contracts';
import { ActAsApi } from '@core/auth/act-as-api.js';
import { UiBanner, UiIcon, UiPill, type Tone } from '@ui/index.js';

const KIND_LABELS: Record<ActAsAuditEntry['kind'], () => string> = {
  start: () => $localize`:@@audit.start:Começou`,
  end: () => $localize`:@@audit.end:Terminou`,
  write: () => $localize`:@@audit.write:Alterou`,
  refused: () => $localize`:@@audit.refused:Recusado (nada mudou)`,
};

const ENDED_LABELS: Record<
  NonNullable<ActAsAuditEntry['endedBy']>,
  () => string
> = {
  actor: () => $localize`:@@audit.endedByActor:voltou para a própria conta`,
  timeout: () => $localize`:@@audit.endedByTimeout:30 minutos acabaram`,
  access: () => $localize`:@@audit.endedByAccess:o acesso mudou`,
};

/**
 * "Auditoria do Ver como" (KBC-060 FR-6, BR-6): every start, end and change made while a
 * master acted as someone, newest first, filtered by a name or e-mail of either side.
 */
@Component({
  selector: 'app-act-as-audit',
  imports: [DatePipe, UiBanner, UiIcon, UiPill],
  template: `
    <label class="ui-search filter">
      <ui-icon name="search" [size]="18" />
      <span class="visually-hidden" i18n="@@audit.filter"
        >Filtrar por pessoa ou master</span
      >
      <input
        #query
        type="search"
        autocomplete="off"
        placeholder="Filtrar por pessoa ou master"
        i18n-placeholder="@@audit.filter"
        (input)="filter.set(query.value)"
      />
    </label>
    @if (audit.error()) {
      <ui-banner tone="err" role="alert">
        <p i18n="@@audit.failed">Não consegui carregar a auditoria.</p>
      </ui-banner>
    } @else if (audit.hasValue()) {
      @if (shown().length === 0) {
        <p class="muted" i18n="@@audit.none">Nenhum registro.</p>
      } @else {
        <div class="table-head audit-cols" aria-hidden="true">
          <span i18n="@@audit.colEvent">Evento</span>
          <span i18n="@@audit.colWho">Quem</span>
          <span i18n="@@audit.colWhen">Quando</span>
          <span i18n="@@audit.colDetail">Detalhe</span>
          <span i18n="@@audit.colReason">Motivo</span>
        </div>
        <ul class="list table">
          @for (entry of shown(); track $index) {
            <li class="item row audit-cols">
              <p class="event">
                <ui-pill [tone]="toneOf(entry)">{{ kindLabel(entry) }}</ui-pill>
              </p>
              <p class="who">
                <span
                  >{{ entry.actor.name || entry.actor.email }}
                  <span i18n="@@audit.as">como</span>
                  {{ entry.person.name || entry.person.email }}</span
                >
              </p>
              <p class="when">
                {{ entry.at | date: 'dd/MM/yyyy HH:mm:ss' }}
              </p>
              <p class="detail">
                @if (entry.route) {
                  <code>{{ entry.method }} {{ entry.route }}</code>
                } @else if (endedLabel(entry); as ended) {
                  {{ ended }}
                } @else {
                  <span aria-hidden="true">—</span>
                }
              </p>
              <p class="reason">
                <span class="reason-label" i18n="@@accesses.reason"
                  >Motivo:</span
                >
                {{ entry.reason }}
              </p>
            </li>
          }
        </ul>
      }
    } @else {
      <p class="muted" i18n="@@audit.loading">Carregando…</p>
    }
  `,
  styleUrl: './acting-lists.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ActAsAudit {
  private readonly api = inject(ActAsApi);
  protected readonly audit = rxResource({ stream: () => this.api.audit() });
  protected readonly filter = signal('');
  protected readonly shown = computed(() => {
    const entries = this.audit.hasValue() ? this.audit.value() : [];
    const query = this.filter().trim().toLowerCase();
    return query
      ? entries.filter((entry) =>
          [entry.actor, entry.person].some((p) =>
            `${p.name} ${p.email}`.toLowerCase().includes(query),
          ),
        )
      : entries;
  });

  protected kindLabel(entry: ActAsAuditEntry): string {
    return KIND_LABELS[entry.kind]();
  }

  /** Started in green, a change in yellow, the rest muted (KBC-132). */
  protected toneOf(entry: ActAsAuditEntry): Tone {
    if (entry.kind === 'start') return 'ok';
    if (entry.kind === 'write') return 'warn';
    return entry.kind === 'refused' ? 'err' : 'muted';
  }

  protected endedLabel(entry: ActAsAuditEntry): string {
    return entry.endedBy ? ENDED_LABELS[entry.endedBy]() : '';
  }
}
