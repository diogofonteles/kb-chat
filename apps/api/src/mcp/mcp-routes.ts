import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { AppError } from '../app-error.js';
import { createKbMcpServer } from './kb-mcp-server.js';
import type { McpTurnRegistry } from './mcp-turns.js';

export const mcpTurnPath = (token: string): string => `/mcp/turns/${token}`;

const params = z.object({ token: z.string().min(16).max(64) });

/**
 * Streamable HTTP MCP endpoint of an open research turn (ADR 0007), stateless: a fresh
 * server and transport per request, the tools bound to the turn. Unknown tokens are 404.
 */
export const mcpRoutes =
  (turns: McpTurnRegistry): FastifyPluginAsync =>
  async (app) => {
    app.all('/mcp/turns/:token', async (request, reply) => {
      const parsed = params.safeParse(request.params);
      const turn = parsed.success ? turns.get(parsed.data.token) : undefined;
      if (!turn) throw new AppError('NOT_FOUND', 'Unknown research turn');
      const server = createKbMcpServer(turn.tools, turn.hooks);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      reply.hijack();
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    });
  };
