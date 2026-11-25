import { droppedFiles, pickedOf, sortFile } from './content-files.js';

const file = (name: string, size = 1) => new File(['x'.repeat(size)], name);

describe('sortFile (KBC-184)', () => {
  it.each([
    ['Caibalion.PDF', 'document'],
    ['notas.md', 'document'],
    ['foto.jpeg', 'document'],
    ['aula.mp3', 'audio'],
    ['aula.OPUS', 'audio'],
    ['aula.mp4', 'video'],
    ['aula.MKV', 'video'],
  ])('%s goes as %s', (name, role) => {
    expect(sortFile(file(name))).toEqual({ role, problem: '' });
  });

  it.each([
    ['.DS_Store', 'ignored'],
    ['Thumbs.db', 'ignored'],
    ['~$relatorio.docx', 'ignored'],
    ['programa.exe', 'refused'],
    ['sem-extensao', 'refused'],
  ])('%s does not go (%s) and says why', (name, role) => {
    const sorted = sortFile(file(name));
    expect(sorted.role).toBe(role);
    expect(sorted.problem).not.toBe('');
  });

  it('an empty document or audio does not go and says why', () => {
    expect(sortFile(file('a.pdf', 0))).toMatchObject({ role: 'refused' });
    expect(sortFile(file('a.mp3', 0))).toMatchObject({ role: 'refused' });
  });
});

describe('reading a folder', () => {
  it("a chosen folder keeps each file's place in it", () => {
    const inside = file('a.pdf');
    Object.defineProperty(inside, 'webkitRelativePath', {
      value: 'Pasta/sub/a.pdf',
    });
    const list = [inside, file('solto.pdf')] as unknown as FileList;
    expect(pickedOf(list).map((one) => one.path)).toEqual([
      'Pasta/sub/a.pdf',
      'solto.pdf',
    ]);
    expect(pickedOf(null)).toEqual([]);
  });

  const entryOf = (name: string): FileSystemEntry =>
    ({
      isFile: true,
      name,
      file: (done: (value: File) => void) => done(file(name)),
    }) as unknown as FileSystemEntry;

  /** A browser answers a folder in parts, and an empty one at the end. */
  const folder = (name: string, parts: FileSystemEntry[][]): FileSystemEntry =>
    ({
      isFile: false,
      name,
      createReader: () => {
        const left = [...parts];
        return {
          readEntries: (done: (value: FileSystemEntry[]) => void) =>
            done(left.shift() ?? []),
        };
      },
    }) as unknown as FileSystemEntry;

  const dropOf = (entries: (FileSystemEntry | null)[], files: File[] = []) =>
    ({
      items: entries.map((entry) => ({ webkitGetAsEntry: () => entry })),
      files: files as unknown as FileList,
    }) as unknown as DataTransfer;

  it('a dropped folder gives every file of every part and sub-folder', async () => {
    const many = Array.from({ length: 100 }, (_, n) => entryOf(`${n}.pdf`));
    const found = await droppedFiles(
      dropOf([
        folder('Pasta', [
          many,
          [entryOf('100.pdf'), folder('sub', [[entryOf('dentro.mp3')]])],
        ]),
        entryOf('solto.pdf'),
      ]),
    );
    expect(found).toHaveLength(103);
    expect(found.map((one) => one.path)).toContain('Pasta/sub/dentro.mp3');
    expect(found.map((one) => one.path)).toContain('solto.pdf');
  });

  it('a folder that cannot be read fails whole, never in part', async () => {
    const broken = {
      isFile: false,
      name: 'Pasta',
      createReader: () => ({
        readEntries: (_: unknown, failed: (err: Error) => void) =>
          failed(new Error('denied')),
      }),
    } as unknown as FileSystemEntry;
    await expect(
      droppedFiles(dropOf([entryOf('a.pdf'), broken])),
    ).rejects.toThrow('denied');
  });

  it('a browser without entries gives the dropped files', async () => {
    const found = await droppedFiles(dropOf([null], [file('a.pdf')]));
    expect(found.map((one) => one.path)).toEqual(['a.pdf']);
  });
});
