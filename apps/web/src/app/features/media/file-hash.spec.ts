import { toArray, lastValueFrom } from 'rxjs';
import { hashFile, type HashEvent } from './file-hash.js';

const eventsOf = (blob: Blob): Promise<HashEvent[]> =>
  lastValueFrom(hashFile(blob).pipe(toArray()));

describe('hashFile (KBC-035 FR-1)', () => {
  it('gives the SHA-256 of a file read in slices, whatever its size', async () => {
    const size = 2.5 * 1024 ** 2;
    const events = await eventsOf(new Blob([new Uint8Array(size).fill(97)]));
    expect(events.at(-1)).toEqual({
      kind: 'done',
      sha256: await webCryptoSha256(new Uint8Array(size).fill(97)),
    });
  });

  it('says how far it went, ending at 100', async () => {
    const events = await eventsOf(new Blob([new Uint8Array(3 * 1024 ** 2)]));
    const percents = events.flatMap((event) =>
      event.kind === 'progress' ? [event.percent] : [],
    );
    expect(percents).toEqual([33, 66, 100]);
  });
});

async function webCryptoSha256(
  bytes: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
