import { probeVolume } from './volume-support.js';

/** A media element whose volume either takes a write (and says so later) or ignores it. */
function probeElement(behaviour: 'writable' | 'read-only' | 'silent') {
  const element = document.createElement('audio');
  let volume = 1;
  Object.defineProperty(element, 'volume', {
    get: () => volume,
    set: (value: number) => {
      if (behaviour === 'read-only') return;
      volume = value;
      if (behaviour === 'writable')
        setTimeout(() => element.dispatchEvent(new Event('volumechange')));
    },
  });
  return () => element;
}

describe('probeVolume (KBC-041 FR-9)', () => {
  afterEach(() => vi.useRealTimers());

  it('says yes when a volume write sticks and the element reports it', async () => {
    await expect(probeVolume(probeElement('writable'))).resolves.toBe(true);
  });

  it('says no at once when the write is ignored (iPhone, iPad)', async () => {
    await expect(probeVolume(probeElement('read-only'))).resolves.toBe(false);
  });

  it('says no when the element never reports the change', async () => {
    vi.useFakeTimers();
    const answer = probeVolume(probeElement('silent'), 500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(answer).resolves.toBe(false);
  });
});
