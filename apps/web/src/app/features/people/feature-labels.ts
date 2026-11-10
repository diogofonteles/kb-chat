import type { Feature } from '@kb-chat/contracts';

/** pt-BR names of the features a master grants (KBC-010 scope). */
export const FEATURE_LABELS: Record<Feature, () => string> = {
  search: () => $localize`:@@feature.search:Buscar documentos`,
  research: () => $localize`:@@feature.research:Pesquisa com IA`,
  'collection-builder': () =>
    $localize`:@@feature.collectionBuilder:Montar/ampliar acervo`,
  'own-ai-settings': () =>
    $localize`:@@feature.ownAiSettings:Configurações de IA próprias`,
  media: () => $localize`:@@feature.media:Ouvir mídia`,
  'media-upload': () => $localize`:@@feature.mediaUpload:Enviar áudios`,
  'collection-create': () =>
    $localize`:@@feature.collectionCreate:Criar acervos`,
  'media-edit': () => $localize`:@@feature.mediaEdit:Editar áudios`,
  'media-edit-ai': () => $localize`:@@feature.mediaEditAi:Propor faixas com IA`,
  'media-library': () => $localize`:@@feature.mediaLibrary:Biblioteca de mídia`,
  'media-speakers': () =>
    $localize`:@@feature.mediaSpeakers:Ver quem fala na transcrição`,
  'media-tracks': () => $localize`:@@feature.mediaTracks:Navegar por faixas`,
  'media-classify': () =>
    $localize`:@@feature.mediaClassify:Classificar mídia por assunto`,
  'media-subjects': () => $localize`:@@feature.mediaSubjects:Assuntos na mídia`,
  'media-research': () =>
    $localize`:@@feature.mediaResearch:Pesquisar faixas com IA`,
  'media-correct': () =>
    $localize`:@@feature.mediaCorrect:Corrigir transcrição`,
  'collection-levels': () =>
    $localize`:@@feature.collectionLevels:Gerenciar níveis de acesso`,
  'media-voice-profiles': () =>
    $localize`:@@feature.mediaVoiceProfiles:Cadastrar perfis de voz`,
};
