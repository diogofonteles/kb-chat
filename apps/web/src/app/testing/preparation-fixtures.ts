import type {
  MediaPreparation,
  PreparationOptions,
  PreparationStage,
  PreparationTrack,
} from '@kb-chat/contracts';

export const MEDIA_ID = '11111111-1111-4111-8111-111111111111';

export const aStage = (
  stage: PreparationStage['stage'],
  state: PreparationStage['state'],
  over: Partial<PreparationStage> = {},
): PreparationStage => ({
  stage,
  state,
  percent: null,
  cuts: null,
  ahead: null,
  blockedBy: null,
  failure: null,
  canRetry: false,
  windows: null,
  reservedUsd: null,
  spentUsd: null,
  estimateUsd: null,
  ...over,
});

export const aTrack = (
  index: number,
  over: Partial<PreparationTrack> = {},
): PreparationTrack => ({
  id: `22222222-2222-4222-8222-0000000000${String(index).padStart(2, '0')}`,
  title: `Pergunta ${index}`,
  startMs: index * 60_000,
  endMs: (index + 1) * 60_000,
  asker: { name: null, voice: 2, audience: true },
  answerer: { name: 'Mestre Gabriel', voice: 1, audience: false },
  status: 'proposed',
  ...over,
});

export const aPreparation = (
  over: Partial<MediaPreparation> = {},
): MediaPreparation => ({
  mediaId: MEDIA_ID,
  title: 'Palestra de 1998',
  topic: 'hermetismo',
  author: 'Mestre Gabriel',
  step: 2,
  skipped: false,
  finished: false,
  plan: {
    transcribe: true,
    speakers: true,
    tracks: 'ai',
    subjects: false,
    acceptedUsd: 0.02,
  },
  stages: [aStage('upload', 'done'), aStage('convert', 'done')],
  separation: null,
  voices: [],
  suggestions: [],
  tracks: [],
  next: null,
  canSwitchToManual: false,
  transcriber: 'on',
  transcriberOffSince: null,
  ...over,
});

export const anOffer = (
  over: Partial<PreparationOptions> = {},
): PreparationOptions => {
  const free = { done: false, refusal: null, minutes: null };
  return {
    options: {
      transcribe: { ...free, minutes: 4 },
      speakers: { ...free, minutes: 3 },
      manual: free,
      ai: free,
      subjects: { ...free, refusal: 'unavailable' },
    },
    aiEstimateUsd: 0.02,
    monthRemainingUsd: 8.4,
    transcriber: 'on',
    transcriberOffSince: null,
    ...over,
  };
};
