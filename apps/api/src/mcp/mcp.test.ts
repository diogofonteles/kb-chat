import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { FakeResearchTools } from '../../test/fake-research-tools.js';
import { registerErrorHandler } from '../error-handler.js';
import { createKbMcpServer } from './kb-mcp-server.js';
import { mcpRoutes } from './mcp-routes.js';
import { McpTurnRegistry, STEP_CAP_TEXT } from './mcp-turns.js';

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
        step: { kind: 'search', text: 'Buscando “ritmo”' },
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
    ).rejects.toThrow(STEP_CAP_TEXT);
    expect(turn?.tools.definitions()).toHaveLength(1);
    opened.close();
    expect(turns.get(opened.token)).toBeUndefined();
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

  it('never logs the turn token, even at info level (ADR 0007)', async () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        lines.push(String(chunk));
        done();
      },
    });
    const app = Fastify({ loggerInstance: pino({ level: 'info' }, sink) });
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
