import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AppError } from '../app-error.js';
import { PUBLIC } from '../modules/auth/index.js';
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

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Only the CLIs the API itself spawns call this endpoint, over loopback. A request that
 * arrives from the network (the reverse proxy, another container) is refused even with a
 * valid token (ADR 0010). The socket address, not request.ip: X-Forwarded-For is not trusted here.
 */
export const isLoopbackRequest = (request: FastifyRequest): boolean =>
  LOOPBACK.has(request.socket.remoteAddress ?? '');

export interface McpRouteOptions {
  /** Addresses besides loopback allowed to call (the Codex sandbox, ADR 0020); still by token. */
  readonly peers?: readonly string[];
}

/** IPv4 peers may arrive mapped (::ffff:a.b.c.d) on a dual-stack socket. */
const unmapped = (address: string): string => address.replace(/^::ffff:/, '');

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
  (turns: McpTurnRegistry, options: McpRouteOptions = {}): FastifyPluginAsync =>
  async (app) => {
    const peers = new Set(options.peers ?? []);
    const allowed = (request: FastifyRequest) =>
      isLoopbackRequest(request) ||
      peers.has(unmapped(request.socket.remoteAddress ?? ''));
    const handler = async (request: FastifyRequest, reply: FastifyReply) => {
      const token = allowed(request) ? tokenOf(request) : undefined;
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
        // Authenticated by the turn's own token, not by a session (ADR 0007).
        const options = { config: { access: PUBLIC } };
        scope.all('/mcp/turns/:token', options, handler);
        scope.all(MCP_BEARER_PATH, options, handler);
      },
      { logSerializers: { req: redactedTurnRequest } },
    );
  };
