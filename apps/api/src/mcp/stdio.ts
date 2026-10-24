import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { ResearchToolsPort } from '../ports/research-tools.js';
import { createKbMcpServer } from './kb-mcp-server.js';

/** `kb-chat mcp`: the same tools over stdio, for MCP clients other than the API's own turns. */
export async function serveKbMcpStdio(tools: ResearchToolsPort): Promise<void> {
  const server = createKbMcpServer(tools);
  await server.connect(new StdioServerTransport());
}
