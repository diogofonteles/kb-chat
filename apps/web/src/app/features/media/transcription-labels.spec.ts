import { aMediaItem, aTranscription } from '../../testing/media-fixtures.js';
import {
  isInFlight,
  pollEveryOf,
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
    expect(transcriptionTextOf(withTranscription(transcription), 'pt-BR')).toBe(
      text,
    );
  });

  it('says since when the transcriber is off, in local time (AC-2)', () => {
    const offSince = new Date(2026, 10, 3, 14, 5).toISOString();
    const text = transcriptionTextOf(
      withTranscription({
        status: 'waiting',
        transcriber: 'off',
        transcriberOffSince: offSince,
      }),
      'pt-BR',
    );
    expect(text).toBe(
      'Aguardando o transcritor · desligado desde 03/11/2026 às 14:05',
    );
  });

  it('says nothing while the item is not playable yet', () => {
    expect(
      transcriptionTextOf(
        withTranscription({ status: 'waiting' }, 'queued'),
        'pt-BR',
      ),
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

  it('asks every 5 s while transcribing, every minute while waiting for an on Mac, never for an off one', () => {
    const at = (transcription: Parameters<typeof aTranscription>[0]) =>
      pollEveryOf([withTranscription(transcription)], 5_000);
    expect(at({ status: 'transcribing' })).toBe(5_000);
    expect(at({ status: 'waiting', transcriber: 'on' })).toBe(60_000);
    expect(at({ status: 'waiting', transcriber: 'off' })).toBeNull();
    expect(at({ status: 'done' })).toBeNull();
    expect(
      pollEveryOf(
        [
          withTranscription({ status: 'waiting', transcriber: 'on' }),
          withTranscription({ status: 'transcribing' }),
        ],
        5_000,
      ),
    ).toBe(5_000);
    expect(isInFlight(withTranscription({ status: 'transcribing' }))).toBe(
      true,
    );
  });
});
