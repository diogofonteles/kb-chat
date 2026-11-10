import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ResearchToolsPort } from '../ports/research-tools.js';
import { createKbMcpServer } from './kb-mcp-server.js';

/**
 * `kb-chat mcp`: the same tools over stdio, for MCP clients other than the API's own turns.
 * The tools are a turn's, built by `ResearchToolsFactory` with a person's view (KBC-104
 * FR-5): there is no way to make them without one, so no person-less path reaches a
 * collection with levels.
 */
export async function serveKbMcpStdio(tools: ResearchToolsPort): Promise<void> {
  const server = createKbMcpServer(tools);
  await server.connect(new StdioServerTransport());
}
