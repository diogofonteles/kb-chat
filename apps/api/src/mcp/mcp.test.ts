import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Writable } from 'node:stream';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { FakeResearchTools } from '../../test/fake-research-tools.js';
import { registerErrorHandler } from '../error-handler.js';
import { createKbMcpServer } from './kb-mcp-server.js';
import { mcpRoutes } from './mcp-routes.js';
import { McpTurnRegistry, stepCapText } from './mcp-turns.js';

async function connect(server: ReturnType<typeof createKbMcpServer>) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(clientSide);
  return client;
}

describe('kb MCP server', () => {
  it('lists the tools with their JSON Schema and reports each result', async () => {
    const onResult = vi.fn();
    const client = await connect(
      createKbMcpServer(new FakeResearchTools(), { onResult }),
    );
    const { tools } = await client.listTools();
    expect(tools).toEqual([
      expect.objectContaining({
        name: 'search_collection',
        inputSchema: expect.objectContaining({ required: ['query'] }),
        annotations: { readOnlyHint: true, openWorldHint: false },
      }),
    ]);
    const result = await client.callTool({
      name: 'search_collection',
      arguments: { query: 'ritmo' },
    });
    expect(result.content).toEqual([
      { type: 'text', text: '[1] A Lei do Ritmo: tudo flui.' },
    ]);
    expect(onResult).toHaveBeenCalledWith(
      expect.objectContaining({
        steps: [{ kind: 'search', text: 'Buscando “ritmo”' }],
      }),
    );
  });

  it('returns a failing tool as a tool error, not a protocol error', async () => {
    const client = await connect(createKbMcpServer(new FakeResearchTools()));
    const result = await client.callTool({ name: 'nope', arguments: {} });
    expect(result).toMatchObject({ isError: true });
  });

  it('stops answering tools past the step cap (KBC-008 BR-3)', async () => {
    const turns = new McpTurnRegistry();
    const opened = turns.open(new FakeResearchTools(), {}, 1);
    const turn = turns.get(opened.token);
    await turn?.tools.call('search_collection', { query: 'a' });
    await expect(
      turn?.tools.call('search_collection', { query: 'b' }),
    ).rejects.toThrow(stepCapText(1));
    expect(turn?.tools.definitions()).toHaveLength(1);
    opened.close();
    expect(turns.get(opened.token)).toBeUndefined();
  });
});

describe('McpTurnRegistry lifetime (KBC-017)', () => {
  it('keeps a long exhaustive turn open for 90 minutes, then drops a forgotten one', () => {
    vi.useFakeTimers();
    try {
      const turns = new McpTurnRegistry();
      const opened = turns.open(new FakeResearchTools(), {}, 80);
      vi.advanceTimersByTime(60 * 60_000);
      expect(turns.get(opened.token)).toBeDefined();
      vi.advanceTimersByTime(31 * 60_000);
      expect(turns.get(opened.token)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('MCP turn endpoint', () => {
  it('answers 404 for an unknown or closed turn', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    await app.register(mcpRoutes(new McpTurnRegistry()));
    const response = await app.inject({
      method: 'POST',
      url: '/mcp/turns/aaaaaaaaaaaaaaaaaaaaaaaa',
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
    await app.close();
  });

  it('refuses a valid turn token that arrives from the network (ADR 0010)', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    const turns = new McpTurnRegistry();
    const opened = turns.open(new FakeResearchTools(), {}, 5);
    await app.register(mcpRoutes(turns));
    const request = {
      method: 'POST' as const,
      url: `/mcp/turns/${opened.token}`,
      headers: { accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    };
    const remote = await app.inject({
      ...request,
      remoteAddress: '172.18.0.3',
    });
    const local = await app.inject(request);
    expect(remote.statusCode).toBe(404);
    expect(local.statusCode).toBe(200);
    opened.close();
    await app.close();
  });

  it('accepts the Codex sandbox address, with the token only (KBC-027 AC-3)', async () => {
    const app = Fastify();
    registerErrorHandler(app);
    const turns = new McpTurnRegistry();
    const opened = turns.open(new FakeResearchTools(), {}, 5);
    await app.register(mcpRoutes(turns, { peers: ['172.30.0.10'] }));
    const call = (remoteAddress: string, url: string) =>
      app.inject({
        method: 'POST',
        url,
        remoteAddress,
        headers: { accept: 'application/json, text/event-stream' },
        payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      });
    expect(
      (await call('172.30.0.10', `/mcp/turns/${opened.token}`)).statusCode,
    ).toBe(200);
    expect(
      (await call('172.30.0.11', `/mcp/turns/${opened.token}`)).statusCode,
    ).toBe(404);
    expect(
      (await call('172.30.0.10', `/mcp/turns/${'x'.repeat(32)}`)).statusCode,
    ).toBe(404);
    opened.close();
    await app.close();
  });

  it('never logs the turn token, even at info level (ADR 0007)', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const logger: FastifyBaseLogger = pino({ level: 'info' }, sink);
    const app = Fastify({ loggerInstance: logger });
    registerErrorHandler(app);
    const turns = new McpTurnRegistry();
    const opened = turns.open(new FakeResearchTools(), {}, 5);
    await app.register(mcpRoutes(turns));
    const response = await app.inject({
      method: 'POST',
      url: `/mcp/turns/${opened.token}`,
      headers: { accept: 'application/json, text/event-stream' },
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    });
    expect(response.statusCode).toBeLessThan(500);
    const log = lines.join('');
    expect(log).toContain('/mcp/turns/***');
    expect(log).not.toContain(opened.token);
    opened.close();
    await app.close();
  });
});
