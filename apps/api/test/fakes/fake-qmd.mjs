#!/usr/bin/env node
// Fake `qmd mcp`: a real MCP stdio server whose `query` tool returns canned hits.
// With a file path as first argument, every query is appended to it as one JSON line
// (the MCP stdio transport passes only a safe default environment to the child).
import { appendFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'fake-qmd', version: '0.0.0' });
server.registerTool(
  'query',
  {
    inputSchema: {
      searches: z.array(z.object({ type: z.string(), query: z.string() })),
      collections: z.array(z.string()),
      limit: z.number(),
      rerank: z.boolean(),
    },
  },
  async (args) => {
    const logFile = process.argv[2];
    if (logFile) appendFileSync(logFile, `${JSON.stringify(args)}\n`);
    if (args.searches[0]?.query === 'crash') process.exit(1);
    const types = args.searches.map((search) => search.type).join('+');
    const results = [
      {
        file: `${args.collections[0]}/raw/articles/a-lei-do-ritmo.md`,
        score: 0.9,
        snippet: `12: ${types} ritmo`,
      },
    ];
    return {
      content: [{ type: 'text', text: 'ok' }],
      structuredContent: { results },
    };
  },
);
await server.connect(new StdioServerTransport());
