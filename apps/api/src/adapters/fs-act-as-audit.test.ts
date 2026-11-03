import { mkdtemp, open, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ActAsAuditEntry } from '@kb-chat/contracts';
import { describe, expect, it } from 'vitest';
import { FsActAsAudit } from './fs-act-as-audit.js';

const person = (name: string) => ({
  id: '11111111-1111-4111-8111-111111111111',
  name,
  email: `${name.toLowerCase()}@example.com`,
});
const entry = (at: string, kind: ActAsAuditEntry['kind'] = 'write') => ({
  at,
  kind,
  actor: person('Dono'),
  person: person('Ana'),
  reason: 'não vê os marcadores',
  method: 'PUT',
  route: '/api/v1/media/preferences',
});

describe('FsActAsAudit (KBC-060 NFR-2)', () => {
  it('appends one line per entry, in a 0600 file per month, and reads them back', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'audit-')), 'audit');
    const audit = new FsActAsAudit(dir);
    await audit.append(entry('2026-10-31T23:59:00.000Z', 'start'));
    await audit.append(entry('2026-11-03T12:00:00.000Z'));
    await audit.append(entry('2026-11-03T12:01:00.000Z', 'end'));
    const file = join(dir, 'act-as-2026-11.jsonl');
    expect((await readFile(file, 'utf8')).trim().split('\n')).toHaveLength(2);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(
      (await audit.since(new Date('2026-10-01T00:00:00Z'))).map((e) => e.kind),
    ).toEqual(['start', 'write', 'end']);
    expect(
      (await audit.since(new Date('2026-11-03T12:00:30Z'))).map((e) => e.kind),
    ).toEqual(['end']);
  });

  it('syncs every line to disk before append resolves', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'audit-')), 'audit');
    const calls: string[] = [];
    const watched: typeof open = async (...args: Parameters<typeof open>) => {
      const handle = await open(...args);
      const append = handle.appendFile.bind(handle);
      const sync = handle.sync.bind(handle);
      handle.appendFile = async (...a: Parameters<typeof append>) => {
        calls.push('append');
        return append(...a);
      };
      handle.sync = async () => {
        calls.push('sync');
        return sync();
      };
      return handle;
    };
    await new FsActAsAudit(dir, watched).append(
      entry('2026-11-03T12:00:00.000Z'),
    );
    expect(calls).toEqual(['append', 'sync']);
  });

  it('skips a bad line without losing the others', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'audit-')), 'audit');
    const audit = new FsActAsAudit(dir);
    await audit.append(entry('2026-11-03T12:00:00.000Z'));
    await writeFile(join(dir, 'act-as-2026-11.jsonl'), '{broken\n', {
      flag: 'a',
    });
    await audit.append(entry('2026-11-03T12:02:00.000Z'));
    expect(await audit.since(new Date('2026-11-01T00:00:00Z'))).toHaveLength(2);
  });

  it('drops whole months older than the retention, nothing newer', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'audit-')), 'audit');
    const audit = new FsActAsAudit(dir);
    await audit.append(entry('2025-10-15T12:00:00.000Z'));
    await audit.append(entry('2025-11-15T12:00:00.000Z'));
    await audit.append(entry('2026-11-03T12:00:00.000Z'));
    expect(await audit.prune(new Date('2025-11-03T00:00:00Z'))).toBe(1);
    expect(
      (await audit.since(new Date('2000-01-01T00:00:00Z'))).map((e) =>
        e.at.slice(0, 7),
      ),
    ).toEqual(['2025-11', '2026-11']);
  });

  it('reads nothing before the first line is written', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'audit-')), 'never');
    expect(await new FsActAsAudit(dir).since(new Date(0))).toEqual([]);
    expect(await new FsActAsAudit(dir).prune(new Date())).toBe(0);
  });
});
