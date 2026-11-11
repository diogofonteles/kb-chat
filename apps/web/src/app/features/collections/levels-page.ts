import { httpResource } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import {
  LEVEL_CODE_MAX,
  LEVEL_DESCRIPTION_MAX,
  topicLevelsSchema,
  type AccessLevel,
  type LevelImpact,
  type LevelPreview,
  type TopicLevels,
} from '@kb-chat/contracts';
import {
  errorDetailsOf,
  errorMessage,
  toUiErrorCode,
} from '@core/api/api-error.js';
import {
  LevelsApi,
  levelsPagePath,
  topicLevelsUrl,
} from '@core/levels/levels-api.js';
import { SessionStore } from '@core/auth/session-store.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { CollectionHeading } from '@features/chat/collection-heading.js';
import { LevelDeleteDialog } from './level-delete-dialog.js';
import { LevelsHistory } from './levels-history.js';
import { UnassignedSection } from './unassigned-section.js';
import { finalize, map, type Observable } from 'rxjs';

/** A move waiting for its confirmation: which level, where it goes, and its preview. */
interface Move {
  readonly id: string;
  readonly to: number;
  readonly order: readonly string[];
  /** The server's count of who gains and loses what (KBC-108 FR-2); null while it comes. */
  readonly preview: LevelPreview | null;
}

/** What the rename form holds while it is open. */
interface Renaming {
  readonly id: string;
  readonly code: string;
  readonly description: string;
}

const ordinal = (n: number): string => `${n}º`;

/**
 * "Níveis de acesso" (T24, KBC-103, ADR 0036): the scale of a top-level collection, lowest
 * first. Masters create, rename and move levels; the first level places every document and
 * person of the collection at it. A sub-collection points to its parent's scale. Below it,
 * "Sem nível" (KBC-107); a holder of "Classificar nível de conteúdo" sees only that section.
 */
@Component({
  selector: 'app-levels-page',
  imports: [RouterLink, UnassignedSection, LevelDeleteDialog, LevelsHistory],
  templateUrl: './levels-page.html',
  styleUrl: './levels-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LevelsPage {
  private readonly api = inject(LevelsApi);
  private readonly chat = inject(ChatStore);
  private readonly session = inject(SessionStore);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly codeInput =
    viewChild<ElementRef<HTMLInputElement>>('codeInput');
  private readonly confirmCreate =
    viewChild<ElementRef<HTMLButtonElement>>('confirmCreate');
  private readonly confirmMove =
    viewChild<ElementRef<HTMLButtonElement>>('confirmMove');
  private readonly renameInput =
    viewChild<ElementRef<HTMLInputElement>>('renameInput');
  private readonly deleteDialog = viewChild(LevelDeleteDialog);
  private readonly heading =
    viewChild<ElementRef<HTMLHeadingElement>>('heading');

  /** The collection, from the route (`/acervos/:slug/niveis`). */
  protected readonly slug = toSignal(
    inject(ActivatedRoute).paramMap.pipe(
      map((params) => params.get('slug') ?? ''),
    ),
    { requireSync: true },
  );

  protected readonly codeMax = LEVEL_CODE_MAX;
  protected readonly descriptionMax = LEVEL_DESCRIPTION_MAX;
  /** Masters manage the scale; whoever classifies sees only "Sem nível" (KBC-107). */
  protected readonly manager = computed(
    () => this.session.me()?.levelsManager === true,
  );
  protected readonly loaded = httpResource(
    () => (this.manager() ? topicLevelsUrl(this.slug()) : undefined),
    { parse: (body) => topicLevelsSchema.parse(body) },
  );
  /** The latest answer of a write, over what was loaded. */
  private readonly written = signal<TopicLevels | null>(null);
  /** Grows with each write: an open history reads itself again (R1-12). */
  protected readonly revision = signal(0);
  protected readonly scale = computed<TopicLevels | null>(() => {
    const written = this.written();
    if (written && written.collection === this.slug()) return written;
    return this.loaded.hasValue() ? this.loaded.value() : null;
  });
  protected readonly levels = computed(() => this.scale()?.levels ?? []);
  protected readonly title = computed(() => this.titleOf(this.slug()));
  protected readonly parentTitle = computed(() => {
    const scale = this.scale();
    return scale ? this.titleOf(scale.collection) : '';
  });
  protected readonly parentPath = computed(() =>
    levelsPagePath(this.scale()?.collection ?? ''),
  );

  protected readonly code = signal('');
  protected readonly description = signal('');
  protected readonly codeError = signal('');
  /** The first level waits for a confirmation that says what it places (BR-4). */
  protected readonly confirmingFirst = signal(false);
  protected readonly moving = signal<Move | null>(null);
  protected readonly renaming = signal<Renaming | null>(null);
  protected readonly renameError = signal('');
  protected readonly busy = signal(false);
  protected readonly failure = signal('');
  protected readonly announcement = signal('');

  constructor() {
    inject(CollectionHeading).follow(
      computed(() => ({ kind: 'topic' as const, slug: this.slug() })),
    );
  }

  /** Each row's buttons name their level (WCAG 2.4.6), the visible words first (2.5.3). */
  protected labelFor(
    action: 'rename' | 'up' | 'down' | 'delete',
    level: AccessLevel,
  ) {
    const { code } = level;
    const labels: Record<typeof action, () => string> = {
      rename: () => $localize`:@@levels.renameLabel:Renomear ${code}:code:`,
      up: () => $localize`:@@levels.moveUpLabel:Mover para cima: ${code}:code:`,
      down: () =>
        $localize`:@@levels.moveDownLabel:Mover para baixo: ${code}:code:`,
      delete: () => $localize`:@@levels.deleteLabel:Apagar ${code}:code:`,
    };
    return labels[action]();
  }

  protected levelCounts(level: AccessLevel): string {
    // Audios only where there are some: a library without media says nothing of them.
    return level.media > 0
      ? $localize`:@@levels.countsWithAudios:${this.documents(level.documents)}:documents: · ${this.audios(level.media)}:audios: · ${this.people(level.people)}:people:`
      : $localize`:@@levels.counts:${this.documents(level.documents)}:documents: · ${this.people(level.people)}:people:`;
  }

  protected audios(count: number): string {
    return count === 1
      ? $localize`:@@levels.oneAudio:1 áudio`
      : $localize`:@@levels.audios:${count}:count: áudios`;
  }

  protected items(count: number): string {
    return count === 1
      ? $localize`:@@levels.oneItem:1 item`
      : $localize`:@@levels.items:${count}:count: itens`;
  }

  protected documents(count: number): string {
    return count === 1
      ? $localize`:@@levels.oneDocument:1 documento`
      : $localize`:@@levels.documents:${count}:count: documentos`;
  }

  protected people(count: number): string {
    return count === 1
      ? $localize`:@@levels.onePerson:1 pessoa`
      : $localize`:@@levels.people:${count}:count: pessoas`;
  }

  /** "Adicionar": the first level asks first; the others go at once. */
  protected add(): void {
    if (this.busy()) return;
    if (!this.code().trim()) {
      this.codeError.set(
        $localize`:@@levels.codeRequired:Escreva o código do nível.`,
      );
      return;
    }
    if (this.levels().length === 0 && !this.confirmingFirst()) {
      this.confirmingFirst.set(true);
      this.focusAfterRender(() => this.confirmCreate());
      return;
    }
    this.create();
  }

  protected cancelFirst(): void {
    this.confirmingFirst.set(false);
    this.focusAfterRender(() => this.codeInput());
  }

  protected create(): void {
    if (this.busy()) return;
    const code = this.code().trim();
    this.confirmingFirst.set(false);
    this.write(
      this.api.create(this.slug(), { code, description: this.description() }),
      {
        done: () => {
          this.announcement.set(
            $localize`:@@levels.created:Nível ${code}:code: criado.`,
          );
          // What was typed while it saved stays (MA-26): only the sent code is cleared.
          if (this.code().trim() !== code) return;
          this.code.set('');
          this.description.set('');
          this.focusAfterRender(() => this.codeInput());
        },
        failed: (message) => this.codeError.set(message),
      },
    );
  }

  /** "Mover": the server counts who gains and loses what before anything moves (KBC-108 BR-3). */
  protected askMove(level: AccessLevel, by: -1 | 1): void {
    const scale = this.scale();
    if (!scale || this.busy()) return;
    const order = this.levels().map((one) => one.id);
    const from = order.indexOf(level.id);
    order.splice(from, 1);
    order.splice(from + by, 0, level.id);
    this.failure.set('');
    this.moving.set({ id: level.id, to: from + by, order, preview: null });
    this.api
      .preview(this.slug(), { order, version: scale.version })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (preview) => {
          const move = this.moving();
          // An answer for a move cancelled or replaced meanwhile is dropped (PD-03).
          if (move?.id !== level.id || move.to !== from + by) return;
          this.moving.set({ ...move, preview });
          this.focusAfterRender(() => this.confirmMove());
        },
        error: (err: unknown) => {
          const move = this.moving();
          // A failure for a move cancelled or replaced meanwhile says nothing (R1-13).
          if (move?.id === level.id && move.to === from + by)
            this.writeFailed(err);
        },
      });
  }

  /** "Mover CI para a 2ª posição? 2 pessoas passam a ver 14 itens; 1 pessoa deixa de ver 6." */
  protected moveText(level: AccessLevel): string {
    const move = this.moving();
    const position = `${(move?.to ?? 0) + 1}ª`;
    const { code } = level;
    const question = $localize`:@@levels.confirmMove:Mover ${code}:code: para a ${position}:position: posição?`;
    if (!move?.preview)
      return `${question} ${$localize`:@@levels.previewing:Contando quem ganha e quem perde acesso…`}`;
    return `${question} ${this.impactText(move.preview)}`;
  }

  private impactText({ gaining, losing }: LevelPreview): string {
    const items = (impact: LevelImpact) =>
      this.items(impact.documents + impact.media);
    const gains = (impact: LevelImpact) =>
      impact.people === 1
        ? $localize`:@@levels.gainsOne:1 pessoa passa a ver ${items(impact)}:items:`
        : $localize`:@@levels.gains:${impact.people}:people: pessoas passam a ver ${items(impact)}:items:`;
    const loses = (impact: LevelImpact) =>
      impact.people === 1
        ? $localize`:@@levels.losesOne:1 pessoa deixa de ver ${items(impact)}:items:`
        : $localize`:@@levels.loses:${impact.people}:people: pessoas deixam de ver ${items(impact)}:items:`;
    const parts = [
      ...(gaining.people > 0 ? [gains(gaining)] : []),
      ...(losing.people > 0 ? [loses(losing)] : []),
    ];
    return parts.length === 0
      ? $localize`:@@levels.noImpact:Ninguém ganha nem perde acesso.`
      : `${parts.join('; ')}.`;
  }

  protected cancelMove(): void {
    this.moving.set(null);
  }

  protected applyMove(): void {
    const move = this.moving();
    if (!move?.preview || this.busy()) return;
    const { order, preview } = move;
    this.moving.set(null);
    this.write(
      this.api.reorder(this.slug(), { order, version: preview.version }),
      {
        done: (scale) => {
          const level = scale.levels[move.to];
          if (level)
            this.announcement.set(
              $localize`:@@levels.moved:${level.code}:code: agora é o ${ordinal(move.to + 1)}:position: de ${scale.levels.length}:total:`,
            );
        },
      },
    );
  }

  /** "Apagar" (KBC-108): the dialog counts what the level holds and asks where it goes. */
  protected askDelete(level: AccessLevel): void {
    this.failure.set('');
    this.deleteDialog()?.openFor(level);
  }

  protected askClear(): void {
    this.failure.set('');
    this.deleteDialog()?.openForAll();
  }

  /** The dialog changed the scale: it replaces the one on screen. */
  protected deleted(scale: TopicLevels): void {
    this.written.set(scale);
    this.revision.update((n) => n + 1);
    this.announcement.set(
      scale.levels.length === 0
        ? $localize`:@@levels.cleared:Os níveis foram tirados. Todos com acesso veem todo o conteúdo.`
        : $localize`:@@levels.deleted:Nível apagado.`,
    );
    this.focusAfterRender(() => this.heading());
  }

  /** Someone changed the scale meanwhile: what is on screen is read again (BR-3). */
  protected refresh(): void {
    this.written.set(null);
    this.loaded.reload();
  }

  protected askRename(level: AccessLevel): void {
    this.renameError.set('');
    this.renaming.set({
      id: level.id,
      code: level.code,
      description: level.description,
    });
    this.focusAfterRender(() => this.renameInput());
  }

  protected editRename(change: Partial<Renaming>): void {
    const current = this.renaming();
    if (current) this.renaming.set({ ...current, ...change });
  }

  protected saveRename(): void {
    const renaming = this.renaming();
    if (!renaming || this.busy()) return;
    const { id, code, description } = renaming;
    this.write(
      this.api.rename(this.slug(), id, { code: code.trim(), description }),
      {
        done: () => {
          this.renaming.set(null);
          this.announcement.set($localize`:@@levels.renamed:Nível salvo.`);
        },
        failed: (message) => this.renameError.set(message),
      },
    );
  }

  protected cancelRename(): void {
    this.renaming.set(null);
  }

  /** One write at a time (PD-02); the answer replaces the scale on screen. */
  private write(
    request: Observable<TopicLevels>,
    outcome: {
      readonly done: (scale: TopicLevels) => void;
      readonly failed?: (message: string) => void;
    },
  ): void {
    this.busy.set(true);
    this.failure.set('');
    this.codeError.set('');
    request
      .pipe(
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (scale) => {
          this.written.set(scale);
          this.revision.update((n) => n + 1);
          outcome.done(scale);
        },
        error: (err: unknown) => this.writeFailed(err, outcome.failed),
      });
  }

  /** Tells what failed; a scale changed meanwhile is read again (KBC-108 BR-3). */
  private writeFailed(
    err: unknown,
    failed: (message: string) => void = (text) => this.failure.set(text),
  ): void {
    this.moving.set(null);
    failed(this.messageOf(err));
    if (toUiErrorCode(err) === 'LEVELS_CHANGED') this.refresh();
  }

  private messageOf(err: unknown): string {
    const code = toUiErrorCode(err);
    if (code === 'LEVEL_CODE_TAKEN') {
      const details = errorDetailsOf(err);
      const taken =
        typeof details === 'object' &&
        details !== null &&
        'code' in details &&
        typeof details.code === 'string'
          ? details.code
          : this.code().trim();
      return $localize`:@@levels.codeTaken:Já existe um nível com o código ${taken}:code:.`;
    }
    if (code === 'VALIDATION_FAILED')
      return $localize`:@@levels.invalid:Não consegui salvar: confira o código (até 12 caracteres, com uma letra ou número).`;
    return errorMessage(code);
  }

  private titleOf(slug: string): string {
    return (
      this.chat.topicList().find((one) => one.slug === slug)?.title ?? slug
    );
  }

  private focusAfterRender(
    target: () => ElementRef<HTMLElement> | undefined,
  ): void {
    afterNextRender(() => target()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }
}
