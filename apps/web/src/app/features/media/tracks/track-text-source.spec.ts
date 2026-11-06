import type {
  MediaPreparation,
  MediaTranscription,
  PreparationStage,
  StageState,
} from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { aMediaItem, aTranscription } from '../../../testing/media-fixtures.js';
import { itemTarget, preparationTarget } from './track-text-source.js';

const transcribed = (
  version: number | null,
  status: MediaTranscription['status'] = 'done',
) => aMediaItem({ transcription: aTranscription({ status, version }) });

const withStage = (state: StageState | null): MediaPreparation =>
  ({
    stages:
      state === null
        ? []
        : [{ stage: 'transcribe', state } as unknown as PreparationStage],
  }) as unknown as MediaPreparation;

describe('itemTarget (step 3)', () => {
  it('reads the current version, even with a newer attempt going on', () => {
    expect(itemTarget(transcribed(2))).toMatchObject({
      status: 'done',
      key: '2',
    });
  });

  it.each([
    ['waiting', 'waiting'],
    ['transcribing', 'waiting'],
    ['failed', 'failed'],
    ['none', 'none'],
  ] as const)('says %s without a transcript as %s (AC-9)', (status, said) => {
    const item = aMediaItem({
      transcription: aTranscription({ status, version: null }),
    });
    expect(itemTarget(item).status).toBe(said);
  });
});

describe('preparationTarget (step 2)', () => {
  it('waits while the transcription runs, and reads once it ends (AC-9)', () => {
    const item = aMediaItem({
      transcription: aTranscription({ status: 'transcribing', version: null }),
    });
    expect(preparationTarget(item, withStage('running')).status).toBe(
      'waiting',
    );
    expect(preparationTarget(item, withStage('queued')).status).toBe('waiting');
    expect(preparationTarget(item, withStage('failed')).status).toBe('failed');
    expect(preparationTarget(item, withStage('done')).status).toBe('done');
  });

  it('reads again when a newer transcription ends (AC-12)', () => {
    const item = transcribed(1);
    const running = preparationTarget(item, withStage('running'));
    const done = preparationTarget(item, withStage('done'));
    expect(running.status).toBe('done');
    expect(done.status).toBe('done');
    expect(done.key).not.toBe(running.key);
  });

  it('follows the item without a transcription stage (an audio not transcribed)', () => {
    expect(preparationTarget(transcribed(null, 'none'), null)).toMatchObject({
      status: 'none',
    });
    expect(preparationTarget(transcribed(3), withStage(null))).toMatchObject({
      status: 'done',
      key: '3',
    });
  });
});
