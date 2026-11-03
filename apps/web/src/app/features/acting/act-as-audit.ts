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

const KIND_LABELS: Record<ActAsAuditEntry['kind'], () => string> = {
  start: () => $localize`:@@audit.start:Começou`,
  end: () => $localize`:@@audit.end:Terminou`,
  write: () => $localize`:@@audit.write:Alterou`,
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
  imports: [DatePipe],
  template: `
    <label class="filter">
      <span i18n="@@audit.filter">Filtrar por pessoa ou master</span>
      <input
        #query
        type="search"
        autocomplete="off"
        (input)="filter.set(query.value)"
      />
    </label>
    @if (audit.error()) {
      <p role="alert" i18n="@@audit.failed">
        Não consegui carregar a auditoria.
      </p>
    } @else if (audit.hasValue()) {
      @if (shown().length === 0) {
        <p class="muted" i18n="@@audit.none">Nenhum registro.</p>
      } @else {
        <ul class="list">
          @for (entry of shown(); track $index) {
            <li class="item">
              <p class="who">
                <strong>{{ kindLabel(entry) }}</strong
                >:
                {{ entry.actor.name || entry.actor.email }}
                <span i18n="@@audit.as">como</span>
                {{ entry.person.name || entry.person.email }}
              </p>
              <p class="when">
                {{ entry.at | date: 'dd/MM/yyyy HH:mm:ss' }}
                @if (entry.route) {
                  · <code>{{ entry.method }} {{ entry.route }}</code>
                }
                @if (endedLabel(entry); as ended) {
                  · {{ ended }}
                }
              </p>
              <p class="reason">
                <span i18n="@@accesses.reason">Motivo:</span>
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

  protected endedLabel(entry: ActAsAuditEntry): string {
    return entry.endedBy ? ENDED_LABELS[entry.endedBy]() : '';
  }
}
