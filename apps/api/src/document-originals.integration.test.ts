import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { closeApp } from '../test/ai-app-harness.js';
import {
  doc,
  memberOf,
  placeDocuments,
  createScale,
  setPersonLevel,
  startLevels,
} from '../test/levels-world.js';

afterEach(closeApp);

const SHA_PDF = 'a'.repeat(64);
const SHA_HTML = 'b'.repeat(64);
const SHA_GONE = 'c'.repeat(64);
const PDF = Buffer.from('%PDF-1.4 o original');

const provenance = (sha: string, name: string, extra = '') =>
  `original_sha256: ${sha}\noriginal_name: "${name}"\nconverter: docling\nconverter_version: "2.0.0"${extra}`;

const DOCS = [
  doc('hermetismo/raw/livro.md', 'O Livro Aberto', {
    body: '# Capítulo 1\n\nA lua.',
    extra: provenance(SHA_PDF, 'O Livro: edição 1.pdf'),
  }),
  doc('hermetismo/raw/pagina.md', 'A Página Salva', {
    body: 'A lua na web.',
    extra: provenance(SHA_HTML, 'page.html'),
  }),
  doc('hermetismo/raw/velado.md', 'O Livro Velado', {
    body: 'A lua velada.',
    extra: provenance(SHA_PDF, 'velado.pdf'),
  }),
  doc('hermetismo/raw/sumiu.md', 'Sem Arquivo', {
    body: 'A lua sem arquivo.',
    extra: provenance(SHA_GONE, 'sumiu.pdf'),
  }),
  doc('hermetismo/raw/diagrama.md', 'O Diagrama', {
    body: '## Descrição gerada\n\nUm triângulo.',
    extra: provenance(SHA_PDF, 'x.pdf', '\ngenerated_description: true'),
  }),
  doc('hermetismo/raw/texto.md', 'Texto Puro', 'A lua sem original.'),
];

const url = (id: string, original = true) =>
  `/api/v1/topics/hermetismo/documents/${encodeURIComponent(id)}${original ? '/original' : ''}`;

async function keepOriginals(vault: string): Promise<void> {
  const folder = join(vault, 'hermetismo', 'raw', '_originals');
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `${SHA_PDF}.pdf`), PDF);
  await writeFile(
    join(folder, `${SHA_HTML}.html`),
    '<script>alert(1)</script>',
  );
  // A Markdown original is kept as `.markdown`: never listed as a document.
  await writeFile(
    join(folder, `${'d'.repeat(64)}.markdown`),
    '# não é documento',
  );
  await writeFile(join(folder, 'solto.md'), '---\ntitle: Solto\n---\nnão');
}

describe('"Ver original" (KBC-148 FR-3, ADR 0040)', () => {
  it('serves the kept original in place, with its own name, and says so in the document', async () => {
    const world = await startLevels(DOCS);
    await keepOriginals(world.vault);
    const ana = await memberOf(world, 'ana@example.com');

    const document = await ana.call('GET', url('raw/livro.md', false));
    expect(document.statusCode, document.body).toBe(200);
    expect(document.json().original).toEqual({
      name: 'O Livro: edição 1.pdf',
      generatedDescription: false,
    });

    const original = await ana.call('GET', url('raw/livro.md'));
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload.equals(PDF)).toBe(true);
    expect(original.headers['content-type']).toBe('application/pdf');
    expect(original.headers['content-disposition']).toBe(
      `inline; filename="O Livro: edi__o 1.pdf"; filename*=UTF-8''${encodeURIComponent('O Livro: edição 1.pdf')}`,
    );
    expect(original.headers['x-content-type-options']).toBe('nosniff');
    expect(original.headers['content-security-policy']).toContain('sandbox');
  });

  it('never shows HTML in place: it downloads, sandboxed', async () => {
    const world = await startLevels(DOCS);
    await keepOriginals(world.vault);
    const ana = await memberOf(world, 'ana@example.com');

    const page = await ana.call('GET', url('raw/pagina.md'));

    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toBe('application/octet-stream');
    expect(page.headers['content-disposition']).toMatch(/^attachment;/);
  });

  it('marks a document whose body holds a generated description (BR-4)', async () => {
    const world = await startLevels(DOCS);
    await keepOriginals(world.vault);

    const diagram = await world.owner('GET', url('raw/diagrama.md', false));

    expect(diagram.json().original).toEqual({
      name: 'x.pdf',
      generatedDescription: true,
    });
  });

  it('a document without an original, or whose file is gone, has no "Ver original" and answers 404', async () => {
    const world = await startLevels(DOCS);
    await keepOriginals(world.vault);
    const ana = await memberOf(world, 'ana@example.com');

    for (const id of ['raw/texto.md', 'raw/sumiu.md']) {
      const document = await ana.call('GET', url(id, false));
      expect(document.json().original).toBeUndefined();
      const original = await ana.call('GET', url(id));
      expect(original.statusCode).toBe(404);
      expect(original.json().error.code).toBe('DOCUMENT_NOT_FOUND');
    }
  });

  it("AC-5: Ana at a low level asking for a high document's original gets the same 404 as for none", async () => {
    const world = await startLevels(DOCS);
    await keepOriginals(world.vault);
    const ana = await memberOf(world, 'ana@example.com');
    await createScale(world, ['QS', 'CDC']);
    await placeDocuments(world, { 'hermetismo:raw/velado.md': 'cdc' });
    await setPersonLevel(world, ana.id, { hermetismo: 'qs' });

    const hidden = await ana.call('GET', url('raw/velado.md'));
    const missing = await ana.call('GET', url('raw/nao-existe.md'));
    const same = await ana.call('GET', url('raw/livro.md'));

    expect(hidden.statusCode).toBe(404);
    expect(hidden.json()).toEqual(missing.json());
    expect(same.statusCode).toBe(200);
    const owner = await world.owner('GET', url('raw/velado.md'));
    expect(owner.statusCode).toBe(200);
  });

  it('a person outside the collection and a request without a session are refused', async () => {
    const world = await startLevels(DOCS);
    await keepOriginals(world.vault);
    const caio = await memberOf(world, 'caio@example.com', {
      topics: ['alquimia'],
    });

    const outside = await caio.call('GET', url('raw/livro.md'));
    const anonymous = await world.started.app.inject({
      method: 'GET',
      url: url('raw/livro.md'),
    });

    // A collection one does not see does not exist for them, as for the document itself.
    expect(outside.statusCode).toBe(404);
    expect(
      (await caio.call('GET', url('raw/livro.md', false))).statusCode,
    ).toBe(404);
    expect(anonymous.statusCode).toBe(401);
  });

  it('kept originals are never documents of the collection', async () => {
    const world = await startLevels(DOCS);
    await keepOriginals(world.vault);

    const loose = await world.owner(
      'GET',
      url('raw/_originals/solto.md', false),
    );

    expect(loose.statusCode).toBe(404);
  });
});
