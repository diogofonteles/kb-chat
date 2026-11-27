import { describe, expect, it } from 'vitest';
import { reasonOf } from './failure-reason.js';

describe('Why a document failed, as masters read it (KBC-191)', () => {
  it('AC-3: a step the Mac ended as stuck says which and for how long, wherever kb spoke first', () => {
    const output = [
      'kb link: qmd candidates: on (collection hermetismo, about 1.2 s per document)',
      'decisions: 2 calls, 0 cache hits, US$ 0.0420',
      'kb: stalled, no work for 1200 s; stopped',
    ].join('\n');
    expect(reasonOf(output)).toBe(
      'o passo kb link ficou 20 min sem trabalhar e foi interrompido',
    );
  });

  it('AC-4: the old fixed limit names the step from the command', () => {
    expect(
      reasonOf(
        "TimeoutExpired: Command '['/Users/diogo/.local/bin/kb', 'link', 'hermetismo', '--budget', '0.0000']' timed out after 1800 seconds",
      ),
    ).toBe('o passo kb link passou do limite de 30 min');
    expect(
      reasonOf(
        "TimeoutExpired: Command '['/Users/diogo/.local/bin/qmd', 'embed', '-c', 'hermetismo', '--timeout', '0']' timed out after 1800 seconds",
      ),
    ).toBe('o passo qmd embed passou do limite de 30 min');
  });

  it("AC-4: a download's limit says it in minutes", () => {
    expect(reasonOf('yt-dlp: took more than 3600 s')).toBe(
      'o passo yt-dlp passou do limite de 60 min',
    );
  });

  it('a reason it does not know is its first line, as before', () => {
    expect(
      reasonOf(
        'kb classify: OpenRouter 502 Bad Gateway\nnothing classified, re-run',
      ),
    ).toBe('kb classify: OpenRouter 502 Bad Gateway');
    expect(reasonOf(null)).toBe('o kb falhou');
    expect(reasonOf('\n  \n')).toBe('o kb falhou');
  });

  it("AC-5: the Mac's home folder never shows", () => {
    expect(
      reasonOf(
        'kb link: open /Users/diogo/dev/personal/hermetismo/raw/a.md: denied',
      ),
    ).toBe('kb link: open ~/dev/personal/hermetismo/raw/a.md: denied');
    expect(reasonOf('kb index: /home/ana/vault: read-only')).toBe(
      'kb index: ~/vault: read-only',
    );
  });

  it('a long reason is cut at 200 characters', () => {
    const reason = reasonOf(`kb link: ${'x'.repeat(400)}`);
    expect(reason).toHaveLength(200);
    expect(reason.endsWith('…')).toBe(true);
  });
});
