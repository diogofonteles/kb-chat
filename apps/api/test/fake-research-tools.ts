import type { AnswerSource } from '@kb-chat/contracts';
import type {
  ResearchToolResult,
  ResearchToolsPort,
} from '../src/ports/research-tools.js';

/** A one-tool stand-in for KBC-008's ResearchTools: every search finds "A Lei do Ritmo" as [1]. */
export class FakeResearchTools implements ResearchToolsPort {
  readonly calls: { name: string; args: unknown }[] = [];
  private readonly sources: AnswerSource[] = [];

  constructor(readonly topic = 'hermetismo') {}

  definitions() {
    return [
      {
        name: 'search_collection',
        description: 'Searches the collection.',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string' } },
          required: ['query'],
        },
      },
    ];
  }

  async call(name: string, args: unknown): Promise<ResearchToolResult> {
    if (name !== 'search_collection') throw new Error(`Unknown tool ${name}`);
    this.calls.push({ name, args });
    const query =
      typeof args === 'object' && args !== null && 'query' in args
        ? String(args.query)
        : '';
    if (this.sources.length === 0)
      this.sources.push({
        n: 1,
        id: 'raw/articles/a-lei-do-ritmo.md',
        title: 'A Lei do Ritmo',
      });
    return {
      text: '[1] A Lei do Ritmo: tudo flui.',
      steps: [{ kind: 'search', text: `Buscando “${query}”` }],
      sources: [...this.sources],
    };
  }
}
