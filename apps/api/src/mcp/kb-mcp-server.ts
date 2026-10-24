import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from '@modelcontextprotocol/sdk/types.js';
import type {
  ResearchToolResult,
  ResearchToolsPort,
} from '../ports/research-tools.js';

/** The server name: Claude Code exposes its tools as `mcp__kb__<tool>`. */
export const KB_MCP_SERVER = 'kb';

export interface KbMcpHooks {
  /** Called after every successful tool call (steps and sources for the stream). */
  readonly onResult?: (result: ResearchToolResult) => void;
}

const errorResult = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }],
  isError: true,
});

/**
 * The research tools (ADR 0006) as an MCP server (ADR 0007), with the tools' JSON Schemas
 * passed through as they are. Failures go back to the model as tool errors, never thrown.
 */
export function createKbMcpServer(
  tools: ResearchToolsPort,
  hooks: KbMcpHooks = {},
): Server {
  const server = new Server(
    { name: 'kb-chat', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.definitions().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { type: 'object' as const, ...tool.parameters },
      // Read-only and closed-world: a client may run several of them at once (KBC-011).
      annotations: { readOnlyHint: true, openWorldHint: false },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await tools.call(
        request.params.name,
        request.params.arguments ?? {},
      );
      hooks.onResult?.(result);
      return { content: [{ type: 'text', text: result.text }] };
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : 'tool failed');
    }
  });
  return server;
}
