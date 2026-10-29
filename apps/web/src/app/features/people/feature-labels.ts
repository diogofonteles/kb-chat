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
};
