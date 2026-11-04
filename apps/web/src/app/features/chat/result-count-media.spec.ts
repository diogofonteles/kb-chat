import { aMediaHit } from '../../testing/fixtures.js';
import { describeMediaCount } from './result-count.js';

describe('describeMediaCount (KBC-070)', () => {
  it('names passages and tracks, each only when there', () => {
    const track = aMediaHit({ match: 'subject' });
    expect(describeMediaCount([aMediaHit()])).toBe('1 trecho na fala');
    expect(describeMediaCount([track, track])).toBe('2 faixas');
    expect(describeMediaCount([aMediaHit(), track])).toBe(
      '1 trecho na fala · 1 faixa',
    );
  });
});
