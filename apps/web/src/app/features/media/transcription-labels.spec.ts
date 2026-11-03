import { aMediaItem, aTranscription } from '../../testing/media-fixtures.js';
import {
  isInFlight,
  lowNoticeOf,
  transcriptionTextOf,
} from './media-labels.js';

const withTranscription = (
  transcription: Parameters<typeof aTranscription>[0],
  status: 'ready' | 'queued' = 'ready',
) => aMediaItem({ status, transcription: aTranscription(transcription) });

describe('transcriptionTextOf (KBC-036 FR-1, BR-5)', () => {
  it.each([
    [{ status: 'none' as const }, ''],
    [
      { status: 'waiting' as const, transcriber: 'on' as const },
      'Aguardando o transcritor',
    ],
    [
      { status: 'waiting' as const, transcriber: 'none' as const },
      'Aguardando o transcritor · nenhum transcritor pareado',
    ],
    [{ status: 'transcribing' as const }, 'Transcrevendo…'],
    [{ status: 'done' as const, confidence: 'normal' as const }, 'Transcrita'],
    [
      { status: 'done' as const, confidence: 'low' as const },
      'Transcrição automática de baixa confiança',
    ],
    [{ status: 'failed' as const }, 'A transcrição falhou'],
  ])('%o reads "%s"', (transcription, text) => {
    expect(transcriptionTextOf(withTranscription(transcription))).toBe(text);
  });

  it('says since when the transcriber is off, in local time (AC-2)', () => {
    const offSince = new Date(2026, 10, 3, 14, 5).toISOString();
    const text = transcriptionTextOf(
      withTranscription({
        status: 'waiting',
        transcriber: 'off',
        transcriberOffSince: offSince,
      }),
    );
    expect(text).toBe(
      'Aguardando o transcritor · desligado desde 03/11 às 14:05',
    );
  });

  it('says nothing while the item is not playable yet', () => {
    expect(
      transcriptionTextOf(withTranscription({ status: 'waiting' }, 'queued')),
    ).toBe('');
  });

  it('keeps the low notice while a new transcription waits (BR-5)', () => {
    const waiting = withTranscription({
      status: 'waiting',
      confidence: 'low',
      version: 1,
    });
    expect(lowNoticeOf(waiting)).toBe(
      'Transcrição automática de baixa confiança',
    );
    expect(
      lowNoticeOf(withTranscription({ status: 'done', confidence: 'low' })),
    ).toBe('');
    expect(
      lowNoticeOf(
        withTranscription({ status: 'waiting', confidence: 'normal' }),
      ),
    ).toBe('');
  });

  it('polls a transcription that moves, never one waiting for a Mac that is off', () => {
    expect(isInFlight(withTranscription({ status: 'transcribing' }))).toBe(
      true,
    );
    expect(
      isInFlight(withTranscription({ status: 'waiting', transcriber: 'on' })),
    ).toBe(true);
    expect(
      isInFlight(withTranscription({ status: 'waiting', transcriber: 'off' })),
    ).toBe(false);
    expect(isInFlight(withTranscription({ status: 'done' }))).toBe(false);
  });
});
