import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  LOCALE_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  linkedSignal,
  signal,
  viewChild,
} from '@angular/core';
import { formatNumber } from '@angular/common';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  DOCUMENT_BATCH_DEFAULT_USD,
  DOCUMENT_BATCH_MAX_USD,
  DOCUMENT_BATCH_MIN_USD,
  type Topic,
} from '@kb-chat/contracts';
import { SessionStore } from '@core/auth/session-store.js';
import { openable, treeTitle } from '@core/topics/topic-tree.js';
import { ChatStore } from '@features/chat/chat-store.js';
import { CollectionDialog } from '@features/collections/collection-dialog.js';
import {
  DocumentUploadsSection,
  type OpenedDocument,
} from '@features/document-upload/document-uploads-section.js';
import { DocumentUploadsStore } from '@features/document-upload/document-uploads-store.js';
import { levelChoicesOf } from '@features/media/level-choices.js';
import { LevelField } from '@features/media/level-field.js';
import { UploadPanel } from '@features/media/upload-panel.js';
import { UiBanner, UiButton, UiChip, UiIcon, UiIconButton } from '@ui/index.js';
import type { IconName } from '@ui/icons.js';
import { map } from 'rxjs';
import {
  FILE_ACCEPT,
  canPickFolder,
  droppedFiles,
  isImage,
  pickedOf,
  sortFile,
  type ChosenFile,
  type FileRole,
  type PickedFile,
} from './content-files.js';
import {
  ContentCostsStore,
  NO_CONTENT,
  type ContentCounts,
} from './content-costs-store.js';
import { ContentEstimate } from './content-estimate.js';
import { MAX_LINKS, parseLinks, type ContentLink } from './content-links.js';
import { ContentSender, type ContentSource } from './content-sender.js';
import { ContentSends } from './content-sends.js';

type Way = 'files' | 'links' | 'media';

const WAYS: readonly {
  readonly way: Way;
  readonly icon: IconName;
  readonly label: string;
}[] = [
  {
    way: 'files',
    icon: 'file',
    label: $localize`:@@addContent.wayFiles:Arquivos`,
  },
  {
    way: 'links',
    icon: 'link',
    label: $localize`:@@addContent.wayLinks:Links`,
  },
  {
    way: 'media',
    icon: 'music',
    label: $localize`:@@addContent.wayMedia:Áudio e vídeo`,
  },
];

const documentsText = (n: number): string =>
  n === 1
    ? $localize`:@@addContent.oneDocument:1 documento`
    : $localize`:@@addContent.documents:${n}:count: documentos`;
const audiosText = (n: number): string =>
  n === 1
    ? $localize`:@@addContent.oneAudio:1 áudio`
    : $localize`:@@addContent.audios:${n}:count: áudios`;
const videosText = (n: number): string =>
  n === 1
    ? $localize`:@@addContent.oneVideo:1 vídeo`
    : $localize`:@@addContent.videos:${n}:count: vídeos`;
const leftText = (n: number): string =>
  n === 1
    ? $localize`:@@addContent.oneLeft:1 não entra`
    : $localize`:@@addContent.leftCount:${n}:count: não entram`;

/** What goes: a video by its sound alone. */
const GOING: ReadonlySet<FileRole> = new Set(['document', 'audio', 'video']);

const countsOfFiles = (files: readonly ChosenFile[]): ContentCounts => {
  const documents = files.filter(({ role }) => role === 'document');
  const image = documents.filter(({ file }) => isImage(file.name)).length;
  return {
    ...NO_CONTENT,
    image,
    document: documents.length - image,
    recording: files.length - documents.length,
  };
};

const countsOfLinks = (links: readonly ContentLink[]): ContentCounts => {
  const of = (kind: ContentLink['kind']) =>
    links.filter((one) => one.kind === kind).length;
  return {
    ...NO_CONTENT,
    page: of('page'),
    recording: of('recording'),
    list: of('list'),
  };
};

/** The same file chosen twice (alone and in its folder too) stays once. */
const identityOf = ({ file, path }: PickedFile): string =>
  [path, file.size, file.lastModified].join('|');

const rootIn = (topics: readonly Topic[], slug: string): string =>
  topics.find((one) => one.slug === slug)?.parent ?? slug;

/**
 * "Adicionar conteúdo" (KBC-184): everything that goes into a collection, from one page. The
 * collection, the way (files, links, audio), what one inclusion may spend, and what is on its
 * way. The Mac converts and files it (ADR 0040); nothing here waits for it.
 */
@Component({
  selector: 'app-add-content-page',
  imports: [
    RouterLink,
    CollectionDialog,
    ContentEstimate,
    ContentSends,
    DocumentUploadsSection,
    LevelField,
    UiBanner,
    UiButton,
    UiChip,
    UiIcon,
    UiIconButton,
    UploadPanel,
  ],
  providers: [ContentCostsStore, ContentSender, DocumentUploadsStore],
  templateUrl: './add-content-page.html',
  styleUrl: './add-content-page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(window:beforeunload)': 'warnBeforeLeaving($event)' },
})
export class AddContentPage {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly session = inject(SessionStore);
  private readonly locale = inject(LOCALE_ID);
  protected readonly chat = inject(ChatStore);
  protected readonly sender = inject(ContentSender);
  protected readonly uploads = inject(DocumentUploadsStore);
  private readonly costs = inject(ContentCostsStore);
  private readonly heading =
    viewChild.required<ElementRef<HTMLElement>>('heading');

  protected readonly ways = WAYS;
  protected readonly accept = FILE_ACCEPT;
  protected readonly picksFolder = canPickFolder();
  protected readonly treeTitle = treeTitle;
  protected readonly levelLabel = $localize`:@@media.level.label:Nível`;
  protected readonly capMin = DOCUMENT_BATCH_MIN_USD;
  protected readonly capMax = DOCUMENT_BATCH_MAX_USD;

  /** Where the content goes: the address's collection, else the one in use. */
  private readonly asked = toSignal(
    this.route.queryParamMap.pipe(map((query) => query.get('acervo'))),
    { initialValue: null },
  );
  protected readonly topics = computed(() => openable(this.chat.topicList()));
  protected readonly topic = linkedSignal<string>(() => {
    const slugs = this.topics().map((one) => one.slug);
    const wanted = [this.asked(), this.chat.topicSlug()].find(
      (slug) => slug !== null && slugs.includes(slug),
    );
    return wanted ?? slugs[0] ?? '';
  });
  protected readonly topicTitle = computed(
    () =>
      this.topics().find((one) => one.slug === this.topic())?.title ??
      this.topic(),
  );
  protected readonly titles = computed(
    () => new Map(this.chat.topicList().map((one) => [one.slug, one.title])),
  );
  protected readonly canCreateCollections = computed(() =>
    this.session.can('collection-create'),
  );

  protected readonly levels = levelChoicesOf(
    () => this.topic(),
    (slug) => rootIn(this.topics(), slug),
  );
  private readonly root = computed(() => rootIn(this.topics(), this.topic()));
  /** Only another scale empties the choice, as in the audio's own form (T14). */
  protected readonly level = linkedSignal<string, string | null>({
    source: this.root,
    computation: () => null,
  });

  protected readonly way = signal<Way>('files');
  protected readonly files = signal<readonly ChosenFile[]>([]);
  protected readonly dragging = signal(false);
  protected readonly text = signal('');
  protected readonly parsed = computed(() => parseLinks(this.text()));
  protected readonly tooManyLinks = computed(
    () => this.parsed().links.length > MAX_LINKS,
  );
  protected readonly uploadingMedia = signal(false);
  private readonly submitted = signal(false);
  private lastFile = 0;

  /** "0,50" as typed; what it means is `capUsd`. */
  protected readonly capText = signal(
    formatNumber(DOCUMENT_BATCH_DEFAULT_USD, this.locale, '1.2-2'),
  );
  protected readonly capUsd = computed<number | null>(() => {
    const value = Number(this.capText().trim().replace(',', '.'));
    return this.capText().trim() !== '' &&
      value >= DOCUMENT_BATCH_MIN_USD &&
      value <= DOCUMENT_BATCH_MAX_USD
      ? value
      : null;
  });

  /** A dropped folder is being read: its files come together, at the end. */
  protected readonly reading = signal(false);
  protected readonly readFailed = signal(false);
  protected readonly going = computed(() =>
    this.files().filter(({ role }) => GOING.has(role)),
  );
  /** What was found and does not go, each with why: nothing is left out in silence. */
  protected readonly left = computed(() =>
    this.files().filter(({ role }) => role === 'refused' || role === 'ignored'),
  );
  protected readonly tally = computed(() => {
    const of = (role: FileRole) =>
      this.files().filter((one) => one.role === role).length;
    return {
      documents: of('document'),
      audios: of('audio'),
      videos: of('video'),
    };
  });
  /** "110 documentos · 12 áudios · 6 não entram": only what there is. */
  protected readonly foundParts = computed(() => {
    const { documents, audios, videos } = this.tally();
    const left = this.left().length;
    const parts = [
      { n: documents, text: documentsText(documents) },
      { n: audios, text: audiosText(audios) },
      { n: videos, text: videosText(videos) },
      { n: left, text: leftText(left) },
    ];
    return parts
      .filter(({ n }) => n > 0)
      .map(({ text }) => text)
      .join(' · ');
  });
  protected readonly count = computed(() =>
    this.way() === 'files'
      ? this.going().length
      : this.way() === 'links'
        ? this.parsed().links.length
        : 0,
  );
  /** What is about to be sent, by what it costs. */
  protected readonly counts = computed<ContentCounts>(() => {
    if (this.way() === 'files') return countsOfFiles(this.going());
    if (this.way() === 'links') return countsOfLinks(this.parsed().links);
    return NO_CONTENT;
  });
  protected readonly levelInvalid = computed(
    () =>
      this.submitted() &&
      this.levels.levels().length > 0 &&
      this.level() === null,
  );
  protected readonly canSend = computed(
    () =>
      this.count() > 0 &&
      this.topic() !== '' &&
      this.capUsd() !== null &&
      !this.tooManyLinks() &&
      !this.levels.failedWhereLevelsMayBe(this.root()),
  );
  protected readonly includeLabel = computed(() => {
    const count = this.count();
    if (count === 0) return $localize`:@@addContent.include:Incluir`;
    return count === 1
      ? $localize`:@@addContent.includeOne:Incluir 1 item`
      : $localize`:@@addContent.includeMany:Incluir ${count}:count: itens`;
  });
  private readonly estimateUsd = computed(() => this.costs.usd(this.counts()));
  /** The whole inclusion would not fit in the ceiling: said before, not in the middle. */
  protected readonly overCap = computed(() => {
    const cap = this.capUsd();
    return cap !== null && this.estimateUsd() > cap;
  });
  protected readonly enoughCap = computed(() =>
    formatNumber(
      Math.min(Math.ceil(this.estimateUsd() * 10) / 10, DOCUMENT_BATCH_MAX_USD),
      this.locale,
      '1.2-2',
    ),
  );

  constructor() {
    // DOM only: the page's own title takes the focus, as the other pages do.
    afterNextRender(() =>
      this.heading().nativeElement.focus({ preventScroll: true }),
    );
    // What was just sent shows up in "Em processamento" without waiting for the next beat.
    effect(() => {
      if (this.sender.summary().sent > 0) this.uploads.refresh();
    });
  }

  protected choose(way: Way): void {
    this.way.set(way);
  }

  protected chooseTopic(slug: string): void {
    this.topic.set(slug);
  }

  protected collectionMade(topic: Topic): void {
    this.chat.putTopic(topic);
    this.topic.set(topic.slug);
  }

  protected filesChosen(event: Event): void {
    const input = event.target as HTMLInputElement;
    this.take(pickedOf(input.files));
    // The same file or folder can be chosen again after it was taken off the list.
    input.value = '';
  }

  protected async dropped(event: DragEvent): Promise<void> {
    event.preventDefault();
    this.dragging.set(false);
    const data = event.dataTransfer;
    if (!data) return;
    this.reading.set(true);
    this.readFailed.set(false);
    try {
      this.take(await droppedFiles(data));
    } catch {
      // Part of a folder is worse than none: the person would think it was all there.
      this.readFailed.set(true);
    } finally {
      this.reading.set(false);
    }
  }

  private take(picked: readonly PickedFile[]): void {
    const known = new Set(this.files().map(identityOf));
    const added = picked
      .filter((one) => !known.has(identityOf(one)))
      .map(({ file, path }) => ({
        ...sortFile(file),
        key: ++this.lastFile,
        file,
        path,
      }));
    this.files.update((all) => [...all, ...added]);
  }

  protected clearFiles(): void {
    this.files.set([]);
  }

  protected useEnoughCap(): void {
    this.capText.set(this.enoughCap());
  }

  protected removeLabel(name: string): string {
    return $localize`:@@addContent.remove:Tirar ${name}:name: da lista`;
  }

  protected removeFile(key: number): void {
    this.files.update((all) => all.filter((one) => one.key !== key));
  }

  /** "Incluir": everything valid goes as one inclusion, and the form is ready for the next. */
  protected include(): void {
    this.submitted.set(true);
    const capUsd = this.capUsd();
    if (!this.canSend() || capUsd === null || this.levelInvalid()) return;
    const sources: readonly ContentSource[] =
      this.way() === 'files'
        ? this.going().map(({ file, path, role }) => ({
            kind: role === 'document' ? 'file' : 'audio',
            file,
            path,
          }))
        : this.parsed().links.map(({ url }) => ({ kind: 'url', url }));
    this.sender.add(sources, {
      topic: this.topic(),
      level: this.level(),
      batch: { id: crypto.randomUUID(), capUsd },
    });
    if (this.way() === 'files') this.files.set([]);
    else this.text.set(this.parsed().refused.join('\n'));
    this.submitted.set(false);
  }

  protected openDocument(doc: OpenedDocument): void {
    this.chat.open(doc.topic, { id: doc.id, title: doc.title });
    void this.router.navigateByUrl('/');
  }

  protected mediaSent(): void {
    void this.router.navigateByUrl('/fila');
  }

  protected warnBeforeLeaving(event: BeforeUnloadEvent): void {
    if (this.sender.busy()) event.preventDefault();
  }
}
