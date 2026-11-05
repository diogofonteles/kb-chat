import { describe, expect, it } from 'vitest';
import { chunkArgs } from './flac-chunk.js';

describe('chunkArgs (KBC-037)', () => {
  it('reads one stretch as 16 kHz mono FLAC on stdout, never to a file', () => {
    const args = chunkArgs({
      source: '/m/a.flac',
      startMs: 1_500,
      endMs: 29_500,
    });
    expect(args.join(' ')).toBe(
      '-hide_banner -nostdin -ss 1.500 -to 29.500 -i /m/a.flac -map 0:a:0 -ac 1 -ar 16000 -c:a flac -f flac -',
    );
  });
});
