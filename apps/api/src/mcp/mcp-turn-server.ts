import Fastify from 'fastify';
import { registerErrorHandler } from '../error-handler.js';
import hostGuard from '../plugins/host-guard.js';
import { mcpRoutes } from './mcp-routes.js';
import type { McpTurnRegistry } from './mcp-turns.js';

export interface McpTurnServer {
  /** Where the subscription CLIs reach the turns' MCP endpoints. */
  readonly baseUrl: string;
  close(): Promise<void>;
}

/**
 * Only the turns' MCP endpoints (ADR 0007), behind the Host guard, on a free port of
 * 127.0.0.1: for a process that runs research turns without the whole API (agent-eval).
 */
export async function startMcpTurnServer(
  turns: McpTurnRegistry,
  allowedHosts: readonly string[],
): Promise<McpTurnServer> {
  const app = Fastify();
  registerErrorHandler(app);
  await app.register(hostGuard, { allowedHosts });
  await app.register(mcpRoutes(turns));
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}`, close: () => app.close() };
}
