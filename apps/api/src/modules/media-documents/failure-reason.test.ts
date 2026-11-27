import { describe, expect, it } from 'vitest';
import { reasonOf, syncReasonOf } from './failure-reason.js';

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

describe('Why a document failed, the review of KBC-191', () => {
  const stuck = 'kb: stalled, no work for 1200 s; stopped';

  it('F3: a stuck step whose "kb <step>:" was cut away still says it stalled', () => {
    expect(reasonOf(`linking raw/a.md (3000/3123)\n${stuck}`)).toBe(
      'o passo do kb ficou 20 min sem trabalhar e foi interrompido',
    );
  });

  it('F4: qmd stuck inside kb index says both', () => {
    const output = `kb index: indexed 3 documents\nqmd: stalled, no work for 1200 s; stopped`;
    expect(reasonOf(output)).toBe(
      'o passo qmd (do kb index) ficou 20 min sem trabalhar e foi interrompido',
    );
  });

  it('F5: many line breaks are read at once', () => {
    // Quadratic took 14 s here; linear takes ~10 ms. Room for a loaded machine.
    const started = performance.now();
    reasonOf(`${'\n'.repeat(100_000)}x`);
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('R2-F4: a limit said after other lines is found', () => {
    expect(reasonOf('baixando 42%\nyt-dlp: took more than 3600 s')).toBe(
      'o passo yt-dlp passou do limite de 60 min',
    );
  });

  it('F6: under a minute is never "0 min"', () => {
    expect(reasonOf('kb link: x\nkb: stalled, no work for 20 s; stopped')).toBe(
      'o passo kb link ficou 1 min sem trabalhar e foi interrompido',
    );
  });

  it('F7: a step of more than one word is named whole', () => {
    expect(reasonOf(`kb topic new: x\n${stuck}`)).toBe(
      'o passo kb topic new ficou 20 min sem trabalhar e foi interrompido',
    );
    expect(reasonOf(`kb review accept: y\n${stuck}`)).toBe(
      'o passo kb review accept ficou 20 min sem trabalhar e foi interrompido',
    );
  });

  it('F8: a command that is not a plain list keeps to what is known', () => {
    expect(
      reasonOf(
        `kb link: TimeoutExpired: Command '["/Users/o'neil/bin/kb", 'link']' timed out after 1800 seconds`,
      ),
    ).toBe('o passo kb link passou do limite de 30 min');
  });

  it('F9: what the app and the Mac write in English reads in Portuguese', () => {
    expect(reasonOf('kb failed')).toBe('o kb falhou');
    expect(reasonOf('kb left it undecided (budget reached): re-run')).toBe(
      'o kb não decidiu: o orçamento acabou; tente de novo',
    );
  });

  it('F12: every home folder is masked, and "kb <step>:" counts only at the start', () => {
    expect(reasonOf('kb link: /Users/a/x and /home/b/y')).toBe(
      'kb link: ~/x and ~/y',
    );
    expect(reasonOf(`error in kb link: x\n${stuck}`)).toBe(
      'o passo do kb ficou 20 min sem trabalhar e foi interrompido',
    );
  });
});

describe('Why the sync with production failed, as masters read it (KBC-191 review F10, R2-F1)', () => {
  // As the Mac sends it: stdout (sync-vault's progress), then stderr (the error that stopped it).
  const progress = [
    'sync-vault: kb-map check hermetismo: ok',
    'sync-vault: /Users/diogo/dev/personal/hermetismo (3 topics, 0 deletions) -> nova-alexandria:/srv/kb-chat/vault',
  ];

  it('is the error of the tool that stopped it, never a progress line', () => {
    const rsync = [
      ...progress,
      'rsync: connection unexpectedly closed (0 bytes received so far) [sender]',
      'rsync error: error in socket IO (code 10) at io.c(232) [sender=3.4.1]',
    ].join('\n');
    expect(syncReasonOf(rsync)).toBe(
      'rsync error: error in socket IO (code 10) at io.c(232) [sender=3.4.1]',
    );
    const ssh = [
      ...progress,
      'ssh: connect to host 203.0.113.10 port 22: Operation timed out',
    ].join('\n');
    expect(syncReasonOf(ssh)).toBe(
      'ssh: connect to host 203.0.113.10 port 22: Operation timed out',
    );
  });

  it("is sync-vault's own word when it gave up, without the Mac's home folder", () => {
    const died = [
      ...progress,
      'sync-vault: would delete 250 files in /Users/diogo/dev/vault (limit 200); nothing was sent',
    ].join('\n');
    expect(syncReasonOf(died)).toBe(
      'sync-vault: would delete 250 files in ~/dev/vault (limit 200); nothing was sent',
    );
    expect(syncReasonOf('')).toBe('a sincronização falhou');
  });
});
