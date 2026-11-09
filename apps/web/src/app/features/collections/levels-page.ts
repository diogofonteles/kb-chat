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
import { ChatStore } from '@features/chat/chat-store.js';
import { CollectionHeading } from '@features/chat/collection-heading.js';
import { finalize, map, type Observable } from 'rxjs';

/** A move waiting for its confirmation: which level, and where it goes. */
interface Move {
  readonly id: string;
  readonly to: number;
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
 * person of the collection at it. A sub-collection points to its parent's scale.
 */
@Component({
  selector: 'app-levels-page',
  imports: [RouterLink],
  templateUrl: './levels-page.html',
  styleUrl: './levels-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LevelsPage {
  private readonly api = inject(LevelsApi);
  private readonly chat = inject(ChatStore);
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

  /** The collection, from the route (`/acervos/:slug/niveis`). */
  protected readonly slug = toSignal(
    inject(ActivatedRoute).paramMap.pipe(
      map((params) => params.get('slug') ?? ''),
    ),
    { requireSync: true },
  );

  protected readonly codeMax = LEVEL_CODE_MAX;
  protected readonly descriptionMax = LEVEL_DESCRIPTION_MAX;
  protected readonly loaded = httpResource(() => topicLevelsUrl(this.slug()), {
    parse: (body) => topicLevelsSchema.parse(body),
  });
  /** The latest answer of a write, over what was loaded. */
  private readonly written = signal<TopicLevels | null>(null);
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
  protected labelFor(action: 'rename' | 'up' | 'down', level: AccessLevel) {
    const { code } = level;
    const labels: Record<typeof action, () => string> = {
      rename: () => $localize`:@@levels.renameLabel:Renomear ${code}:code:`,
      up: () => $localize`:@@levels.moveUpLabel:Mover para cima: ${code}:code:`,
      down: () =>
        $localize`:@@levels.moveDownLabel:Mover para baixo: ${code}:code:`,
    };
    return labels[action]();
  }

  protected levelCounts(level: AccessLevel): string {
    return $localize`:@@levels.counts:${this.documents(level.documents)}:documents: · ${this.people(level.people)}:people:`;
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

  protected askMove(level: AccessLevel, by: -1 | 1): void {
    const from = this.levels().findIndex((one) => one.id === level.id);
    this.moving.set({ id: level.id, to: from + by });
    this.focusAfterRender(() => this.confirmMove());
  }

  /**
   * What the move changes, by direction (UP-07, MA-27): the level it passes either starts
   * seeing this one's content (down) or stops seeing it (up).
   */
  protected moveText(level: AccessLevel): string {
    const to = this.moving()?.to ?? 0;
    const passed = this.levels()[to]?.code ?? '';
    const position = `${to + 1}ª`;
    const from = this.levels().findIndex((one) => one.id === level.id);
    const { code } = level;
    return to > from
      ? $localize`:@@levels.confirmMoveDown:Mover ${code}:code: para a ${position}:position: posição? Quem está em ${passed}:passed: passa a ver o conteúdo de ${code}:code: na hora, e quem está em ${code}:code: deixa de ver o de ${passed}:passed:.`
      : $localize`:@@levels.confirmMoveUp:Mover ${code}:code: para a ${position}:position: posição? Quem está em ${passed}:passed: deixa de ver o conteúdo de ${code}:code: na hora, e quem está em ${code}:code: passa a ver o de ${passed}:passed:.`;
  }

  protected cancelMove(): void {
    this.moving.set(null);
  }

  protected applyMove(): void {
    const move = this.moving();
    if (!move || this.busy()) return;
    const order = this.levels().map((one) => one.id);
    const from = order.indexOf(move.id);
    order.splice(from, 1);
    order.splice(move.to, 0, move.id);
    this.moving.set(null);
    this.write(this.api.reorder(this.slug(), order), {
      done: (scale) => {
        const level = scale.levels[move.to];
        if (level)
          this.announcement.set(
            $localize`:@@levels.moved:${level.code}:code: agora é o ${ordinal(move.to + 1)}:position: de ${scale.levels.length}:total:`,
          );
      },
    });
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
          outcome.done(scale);
        },
        error: (err: unknown) => {
          const message = this.messageOf(err);
          (outcome.failed ?? ((text: string) => this.failure.set(text)))(
            message,
          );
        },
      });
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
