import type {
  MediaPreparation,
  PreparationStage,
  PreparationTrack,
} from '@kb-chat/contracts';
import { PreparationAnnouncer } from './preparation-announcer.js';

const stage = (
  id: PreparationStage['stage'],
  state: PreparationStage['state'],
  percent: number | null = null,
): PreparationStage => ({
  stage: id,
  state,
  percent,
  cuts: null,
  ahead: null,
  blockedBy: null,
  failure: state === 'failed' ? 'provider' : null,
  canRetry: false,
  windows: null,
  reservedUsd: null,
  spentUsd: null,
  estimateUsd: null,
});

const track = (index: number): PreparationTrack => ({
  id: `track-${index}`,
  title: null,
  startMs: index,
  endMs: index + 1,
  asker: null,
  answerer: null,
  status: 'proposed',
});

const reading = (
  stages: PreparationStage[],
  tracks: number,
): MediaPreparation =>
  ({
    stages,
    tracks: Array.from({ length: tracks }, (_, index) => track(index)),
  }) as MediaPreparation;

describe('PreparationAnnouncer (BR-9)', () => {
  it('says nothing about what was already there', () => {
    const announcer = new PreparationAnnouncer(() => 0);
    expect(announcer.observe(reading([stage('tracks', 'running')], 5))).toBe(
      '',
    );
  });

  it('says when a stage starts, ends or fails', () => {
    const announcer = new PreparationAnnouncer(() => 0);
    announcer.observe(reading([stage('transcribe', 'queued')], 0));
    expect(announcer.observe(reading([stage('transcribe', 'running')], 0))).toBe(
      'Transcrição começou.',
    );
    expect(announcer.observe(reading([stage('transcribe', 'done')], 0))).toBe(
      'Transcrição terminou.',
    );
    expect(announcer.observe(reading([stage('transcribe', 'failed')], 0))).toContain(
      'Falhou',
    );
  });

  it('never says a percentage', () => {
    const announcer = new PreparationAnnouncer(() => 0);
    announcer.observe(reading([stage('transcribe', 'running', 10)], 0));
    expect(
      announcer.observe(reading([stage('transcribe', 'running', 35)], 0)),
    ).toBe('');
  });

  it('says 12 tracks in 40 s in at most 4 sentences, the count adding up (AC-12)', () => {
    let now = 0;
    const announcer = new PreparationAnnouncer(() => now);
    const running = [stage('tracks', 'running')];
    announcer.observe(reading(running, 0));
    const said: string[] = [];
    for (let tick = 1; tick <= 13; tick++) {
      now = tick * 3_000;
      const sentence = announcer.observe(reading(running, Math.min(tick, 12)));
      if (sentence) said.push(sentence);
    }
    expect(said.length).toBeLessThanOrEqual(4);
    expect(said[0]).toBe('1 faixa nova; 1 até agora.');
    expect(said.at(-1)).toContain('12 até agora');
  });
});
