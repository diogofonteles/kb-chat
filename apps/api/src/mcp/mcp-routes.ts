import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../app-error.js';
import { createKbMcpServer } from './kb-mcp-server.js';
import type { McpTurnRegistry } from './mcp-turns.js';

export const mcpTurnPath = (token: string): string => `/mcp/turns/${token}`;

const TOKEN_IN_PATH = /\/mcp\/turns\/[^/?#]*/;

/** The request as logged, with the turn token replaced: the token is never logged (ADR 0007). */
export const redactedTurnRequest = (request: FastifyRequest) => ({
  method: request.method,
  url: request.url.replace(TOKEN_IN_PATH, '/mcp/turns/***'),
  host: request.host,
  remoteAddress: request.ip,
});

const params = z.object({ token: z.string().min(16).max(64) });

/**
 * Streamable HTTP MCP endpoint of an open research turn (ADR 0007), stateless: a fresh
 * server and transport per request, the tools bound to the turn. Unknown tokens are 404.
 */
export const mcpRoutes =
  (turns: McpTurnRegistry): FastifyPluginAsync =>
  async (app) => {
    const options = { logSerializers: { req: redactedTurnRequest } };
    app.all('/mcp/turns/:token', options, async (request, reply) => {
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
