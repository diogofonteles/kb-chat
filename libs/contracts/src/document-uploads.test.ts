import { describe, expect, it } from 'vitest';
import { docIngestResultRequestSchema } from './document-uploads.js';

describe('docIngestResultRequestSchema: what kb refused (KBC-009)', () => {
  const refusedAt = (document: string) =>
    docIngestResultRequestSchema.safeParse({
      worker: 'mac',
      leaseId: '11111111-1111-4111-8111-111111111111',
      outcome: {
        state: 'failed',
        failure: 'not-accepted',
        detail: '',
        refused: { document, reason: 'thin', excerpt: '' },
      },
    }).success;

  it.each([
    'raw/_quarantine/rasa.md',
    'raw/_quarantine/articles/o que é.md',
    'raw/_quarantine/a/b/c-2.md',
  ])('%s is in the quarantine', (document) => {
    expect(refusedAt(document)).toBe(true);
  });

  it.each([
    'raw/articles/rasa.md',
    'raw/_quarantine/',
    'raw/_quarantine/rasa.txt',
    'raw/_quarantine/../articles/rasa.md',
    'raw/_quarantine/a/../../rasa.md',
    'raw/_quarantine/.git/rasa.md',
    'raw/_quarantine//rasa.md',
    'raw/_quarantine/rasa.md\nx',
    '/raw/_quarantine/rasa.md',
    `raw/_quarantine/${'a'.repeat(500)}.md`,
  ])('%j is not', (document) => {
    expect(refusedAt(document)).toBe(false);
  });
});
