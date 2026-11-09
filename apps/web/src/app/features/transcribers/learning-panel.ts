import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  transcriptLearningSchema,
  type LearnedExample,
  type LearnedRule,
  type LearnedTerm,
  type TranscriptLearning,
} from '@kb-chat/contracts';
import { formatClock } from '@kb-chat/player-core';
import { LearningApi, learningUrl } from '@core/media/learning-api.js';

/** Rules shown at first, then "Mostrar mais" (SL long lists). */
const PAGE = 20;

interface Notice {
  readonly kind: 'ok' | 'error';
  readonly text: string;
}

const ruleName = (rule: LearnedRule): string =>
  $localize`:@@learning.ruleName:Regra ${rule.before}:before: → ${rule.after}:after:`;

const termName = (term: LearnedTerm): string =>
  $localize`:@@learning.termName:Termo ${term.term}:term:`;

/** "depois de «com» · antes de «foi»", or "em qualquer contexto" (BR-2, BR-3). */
function contextText(rule: LearnedRule): string {
  if (rule.contextBefore === null)
    return $localize`:@@learning.anyContext:em qualquer contexto`;
  const before =
    rule.contextBefore === ''
      ? $localize`:@@learning.atStart:no começo do trecho`
      : $localize`:@@learning.after:depois de «${rule.contextBefore}:word:»`;
  const after =
    rule.contextAfter === ''
      ? $localize`:@@learning.atEnd:no fim do trecho`
      : $localize`:@@learning.before:antes de «${rule.contextAfter ?? ''}:word:»`;
  return `${before} · ${after}`;
}

function countsText(rule: LearnedRule): string {
  const corrections =
    rule.corrections === 1
      ? $localize`:@@learning.oneCorrection:1 correção`
      : $localize`:@@learning.corrections:${rule.corrections}:n: correções`;
  const recordings =
    rule.recordings === 1
      ? $localize`:@@learning.oneRecording:em 1 gravação`
      : $localize`:@@learning.recordings:em ${rule.recordings}:n: gravações`;
  const applied = $localize`:@@learning.applied:aplicada ${rule.applied}:n: vezes`;
  const undone =
    rule.undone === 0
      ? ''
      : ` · ${$localize`:@@learning.undone:desfeita ${rule.undone}:n:`}`;
  return `${corrections} ${recordings} · ${applied}${undone}`;
}

/** The rule's state in words, never only a colour (UP-20). */
function stateText(rule: LearnedRule): string {
  const texts: Record<LearnedRule['state'], () => string> = {
    on: () =>
      rule.switchedBy
        ? $localize`:@@learning.onBy:Ligada por ${rule.switchedBy}:name:`
        : $localize`:@@learning.on:Ligada`,
    off: () =>
      rule.switchedBy
        ? $localize`:@@learning.offBy:Desligada por ${rule.switchedBy}:name:`
        : $localize`:@@learning.off:Desligada`,
    'auto-off': () =>
      rule.undone === 1
        ? $localize`:@@learning.autoOffOne:Desligada: desfeita 1 vez`
        : $localize`:@@learning.autoOff:Desligada: desfeita ${rule.undone}:n: vezes`,
    conflict: () =>
      $localize`:@@learning.conflict:Em conflito com «${rule.conflictWith ?? ''}:other:»`,
  };
  return texts[rule.state]();
}

function termStateText(term: LearnedTerm): string {
  const texts: Record<LearnedTerm['state'], string> = {
    'in-list': $localize`:@@learning.inList:Na lista do transcritor`,
    'no-room': $localize`:@@learning.noRoom:Fora por falta de espaço`,
    off: term.switchedBy
      ? $localize`:@@learning.termOffBy:Desligado por ${term.switchedBy}:name:`
      : $localize`:@@learning.termOff:Desligado`,
  };
  return texts[term.state];
}

/**
 * "Aprendido das correções" (KBC-113 FR-7, T21): what the corrections taught the next
 * transcriptions, rules with their context and learned terms, each with a switch that saves
 * at once. Masters only, as the rest of "Termos da transcrição".
 */
@Component({
  selector: 'app-learning-panel',
  templateUrl: './learning-panel.html',
  styleUrls: [
    '../settings/settings-form.css',
    './transcribers-panel.css',
    './learning-panel.css',
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LearningPanel {
  private readonly api = inject(LearningApi);

  protected readonly resource = httpResource(() => learningUrl(), {
    parse: (body) => transcriptLearningSchema.parse(body),
  });
  /** What a switch answered, newer than the first read. */
  private readonly answered = signal<TranscriptLearning | null>(null);
  protected readonly learning = computed<TranscriptLearning | null>(
    () =>
      this.answered() ??
      (this.resource.hasValue() ? this.resource.value() : null),
  );
  protected readonly shown = signal(PAGE);
  protected readonly rules = computed(
    () => this.learning()?.rules.slice(0, this.shown()) ?? [],
  );
  protected readonly hidden = computed(
    () => (this.learning()?.rules.length ?? 0) - this.rules().length,
  );
  /** The switch waiting for its answer: one request at a time (PD-02). */
  protected readonly pending = signal<string | null>(null);
  protected readonly notice = signal<Notice | null>(null);

  protected readonly ruleName = ruleName;
  protected readonly termName = termName;
  protected readonly contextText = contextText;
  protected readonly countsText = countsText;
  protected readonly stateText = stateText;
  protected readonly termStateText = termStateText;
  protected readonly clock = formatClock;

  /** The recording at the corrected word (KBC-038 `?t=`). */
  protected exampleHref(example: LearnedExample): string {
    return `/midia/${example.mediaId}?t=${Math.floor(example.startMs / 1000)}`;
  }

  protected readonly free = computed(() => {
    const tokens = this.learning()?.tokens;
    return tokens ? Math.max(0, tokens.limit - tokens.manual) : 0;
  });

  protected isOn(rule: LearnedRule): boolean {
    return rule.state === 'on';
  }

  protected toggleRule(rule: LearnedRule): void {
    const enabled = !this.isOn(rule);
    this.send({ kind: 'rules', id: rule.id, enabled }, () =>
      enabled
        ? $localize`:@@learning.ruleOn:Regra ligada. Vale para as próximas transcrições.`
        : $localize`:@@learning.ruleOff:Regra desligada. Vale para as próximas transcrições.`,
    );
  }

  protected toggleTerm(term: LearnedTerm): void {
    const enabled = term.state === 'off';
    this.send({ kind: 'terms', id: term.id, enabled }, () =>
      enabled
        ? $localize`:@@learning.termOnDone:Termo ligado. Vale para as próximas transcrições.`
        : $localize`:@@learning.termOffDone:Termo desligado. Vale para as próximas transcrições.`,
    );
  }

  protected showMore(): void {
    this.shown.update((count) => count + PAGE);
  }

  protected reload(): void {
    this.answered.set(null);
    this.resource.reload();
  }

  private send(
    change: {
      readonly kind: 'rules' | 'terms';
      readonly id: string;
      readonly enabled: boolean;
    },
    done: () => string,
  ): void {
    const { kind, id, enabled } = change;
    if (this.pending() !== null) return;
    this.pending.set(id);
    this.notice.set(null);
    this.api.switch(kind, id, enabled).subscribe({
      next: (learning) => {
        this.answered.set(learning);
        this.pending.set(null);
        this.notice.set({ kind: 'ok', text: done() });
      },
      error: () => {
        this.pending.set(null);
        this.notice.set({
          kind: 'error',
          text:
            kind === 'rules'
              ? $localize`:@@learning.ruleFailed:Não foi possível mudar a regra. Tente de novo.`
              : $localize`:@@learning.termFailed:Não foi possível mudar o termo. Tente de novo.`,
        });
      },
    });
  }
}
