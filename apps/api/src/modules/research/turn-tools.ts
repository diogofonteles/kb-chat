import type { ToolDefinition } from '../../ports/llm.js';
import type {
  ResearchToolResult,
  ResearchToolsFactory,
  ResearchToolsPort,
} from '../../ports/research-tools.js';
import { SourceBook } from './source-book.js';
import type { ResearchTools } from './tools.js';

/**
 * The research tools of one turn behind ResearchToolsPort, for the subscription CLIs'
 * MCP endpoint (ADR 0007): the same tools, outputs and [n] numbering as the in-API loop,
 * with a source book of its own. Invalid arguments come back as text for the model.
 */
export class TurnResearchTools implements ResearchToolsPort {
  private readonly book = new SourceBook();
  private calls = 0;

  constructor(
    private readonly tools: ResearchTools,
    private readonly topic: string,
  ) {}

  definitions(): readonly ToolDefinition[] {
    return this.tools.definitions;
  }

  async call(name: string, args: unknown): Promise<ResearchToolResult> {
    if (!this.tools.definitions.some((tool) => tool.name === name))
      throw new Error(`Unknown tool ${name}`);
    this.calls += 1;
    const prepared = this.tools.prepare(
      { id: `mcp-${this.calls}`, name, arguments: JSON.stringify(args ?? {}) },
      { topic: this.topic, book: this.book },
    );
    const text = await prepared.run();
    return { text, steps: prepared.steps, sources: this.book.list() };
  }
}

/**
 * A fresh tool set per turn; it also starts building the topic's find_text cache, as the
 * in-API loop does, while the CLI starts up.
 */
export const turnToolsFactory =
  (tools: ResearchTools): ResearchToolsFactory =>
  (topic) => {
    void tools.warm(topic).catch(() => undefined);
    return new TurnResearchTools(tools, topic);
  };
