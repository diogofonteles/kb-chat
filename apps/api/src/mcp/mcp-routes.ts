import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../app-error.js';
import { createKbMcpServer } from './kb-mcp-server.js';
import type { McpTurnRegistry } from './mcp-turns.js';

export const mcpTurnPath = (token: string): string => `/mcp/turns/${token}`;
/** The same endpoint with the token in `Authorization: Bearer` (CLIs that read it from env). */
export const MCP_BEARER_PATH = '/mcp/turn';

const TOKEN_IN_PATH = /\/mcp\/turns\/[^/?#]*/;

/** The request as logged, with the turn token replaced: the token is never logged (ADR 0007). */
export const redactedTurnRequest = (request: FastifyRequest): string =>
  `${request.method} ${request.url.replace(TOKEN_IN_PATH, '/mcp/turns/***')}`;

const tokenSchema = z.string().min(16).max(64);
const params = z.object({ token: tokenSchema });
const BEARER = /^Bearer (\S+)$/;

function bearerToken(request: FastifyRequest): string | undefined {
  const match = BEARER.exec(request.headers.authorization ?? '');
  const parsed = tokenSchema.safeParse(match?.[1]);
  return parsed.success ? parsed.data : undefined;
}

function tokenOf(request: FastifyRequest): string | undefined {
  const parsed = params.safeParse(request.params);
  return parsed.success ? parsed.data.token : bearerToken(request);
}

/**
 * Streamable HTTP MCP endpoint of an open research turn (ADR 0007), stateless: a fresh
 * server and transport per request, the tools bound to the turn. Unknown tokens are 404.
 * The token comes in the path or as a bearer header.
 */
export const mcpRoutes =
  (turns: McpTurnRegistry): FastifyPluginAsync =>
  async (app) => {
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const token = tokenOf(request);
      const turn = token === undefined ? undefined : turns.get(token);
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
    };
    await app.register(
      async (scope) => {
        scope.all('/mcp/turns/:token', handler);
        scope.all(MCP_BEARER_PATH, handler);
      },
      { logSerializers: { req: redactedTurnRequest } },
    );
  };
