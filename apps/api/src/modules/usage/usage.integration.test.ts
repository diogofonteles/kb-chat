import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE_VAULT } from '../../../test/fixture-paths.js';
import { FsVaultAdapter } from '../../adapters/fs-vault-adapter.js';
import {
  JsonlUsageLog,
  parseUsageLog,
} from '../../adapters/jsonl-usage-log.js';
import { buildApp } from '../../app.js';
import { loadConfig } from '../../config.js';
import { createLogger } from '../../logger.js';
import { createSearchIndex } from '../../search-index-factory.js';

const HOST = { host: 'localhost:3000' };
const SESSION = '0b6f1f0e-6a3e-4d0a-9d55-6f1c2b9b8a11';
const file = join(mkdtempSync(join(tmpdir(), 'kbchat-usage-')), 'events.jsonl');
let app: FastifyInstance;

beforeAll(async () => {
  const config = loadConfig({
    KB_VAULT: FIXTURE_VAULT,
    KB_CHAT_SEARCH: 'fixture',
    LOG_LEVEL: 'silent',
  });
  const vault = new FsVaultAdapter(config.KB_VAULT);
  const index = await createSearchIndex({
    config,
    vault,
    log: createLogger('silent'),
  });
  app = await buildApp({
    config,
    vault,
    index,
    usage: new JsonlUsageLog(file),
  });
});

afterAll(async () => {
  await app.close();
});

const post = (payload: object) =>
  app.inject({ method: 'POST', url: '/api/v1/events', headers: HOST, payload });

describe('GET /api/v1/topics/:topic/suggestions (KBC-006 FR-1)', () => {
  it('returns at most six subjects, the largest first', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/topics/hermetismo/suggestions',
      headers: HOST,
    });
    expect(response.statusCode).toBe(200);
    const { items } = response.json<{
      items: { concept: string; count: number }[];
    }>();
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(6);
    const counts = items.map((item) => item.count);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });

  it('refuses an unknown collection', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/topics/nao-existe/suggestions',
      headers: HOST,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('TOPIC_NOT_FOUND');
  });
});

describe('POST /api/v1/events (KBC-006 FR-3)', () => {
  it('appends a search and the opened document with the same session (AC-3)', async () => {
    const search = await post({
      sessionId: SESSION,
      event: {
        type: 'search',
        question: 'lei do ritmo',
        mode: 'all',
        filterCount: 0,
        total: 3,
        tookMs: 120,
      },
    });
    const open = await post({
      sessionId: SESSION,
      event: { type: 'open_doc', position: 2 },
    });
    expect([search.statusCode, open.statusCode]).toEqual([202, 202]);
    const records = parseUsageLog(await readFile(file, 'utf8'));
    expect(records.map((r) => [r.type, r.sessionId, r.principal])).toEqual([
      ['search', SESSION, 'owner'],
      ['open_doc', SESSION, 'owner'],
    ]);
    expect(Date.parse(records[0]?.ts ?? '')).not.toBeNaN();
  });

  it('refuses an unknown event or a session that is not a UUID', async () => {
    expect(
      (await post({ sessionId: SESSION, event: { type: 'export' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post({ sessionId: 'x', event: { type: 'ai_cancel' } })).statusCode,
    ).toBe(400);
  });
});
