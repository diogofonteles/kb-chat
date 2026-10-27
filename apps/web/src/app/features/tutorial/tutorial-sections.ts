/** One section of the tutorial (KBC-032): its anchor (part of public links) and title. */
export interface TutorialSection {
  /** Stable anchor: `/tutorial#<id>` is shared in messages, so never rename one. */
  readonly id: string;
  readonly title: string;
}

/** The table of contents, in page order; the page has one h2 per entry with this id. */
export const TUTORIAL_SECTIONS: readonly TutorialSection[] = [
  {
    id: 'o-que-e',
    title: $localize`:@@tutorial.toc.about:O que é a Nova Alexandria`,
  },
  { id: 'entrar', title: $localize`:@@tutorial.toc.signIn:Entrar` },
  {
    id: 'busca',
    title: $localize`:@@tutorial.toc.search:Buscar documentos (sem IA)`,
  },
  {
    id: 'pesquisa-com-ia',
    title: $localize`:@@tutorial.toc.research:Pesquisa com IA`,
  },
  {
    id: 'historico',
    title: $localize`:@@tutorial.toc.history:Histórico de conversas`,
  },
  { id: 'sua-ia', title: $localize`:@@tutorial.toc.ownAi:Sua IA` },
  {
    id: 'preferencias',
    title: $localize`:@@tutorial.toc.preferences:Preferências`,
  },
  {
    id: 'administradores',
    title: $localize`:@@tutorial.toc.admins:Para administradores`,
  },
  {
    id: 'perguntas-frequentes',
    title: $localize`:@@tutorial.toc.faq:Perguntas frequentes`,
  },
];
