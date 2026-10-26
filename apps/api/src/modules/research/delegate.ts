import { z } from 'zod';
import type { ToolDefinition } from '../../ports/llm.js';

/** The orchestrator's tool (exhaustive profile, in-API loop, ADR 0014). */
export const DELEGATE_TOOL = 'delegate';
/** Tasks one delegate call may hand out. */
export const MAX_DELEGATED_TASKS = 5;

export const delegateArgsSchema = z.object({
  tasks: z
    .array(
      z.object({
        title: z
          .string()
          .trim()
          .min(3)
          .max(80)
          .describe(
            'Nome curto da tarefa, mostrado ao leitor ("Livros de 1 a 60").',
          ),
        task: z
          .string()
          .trim()
          .min(10)
          .max(2_000)
          .describe(
            'A tarefa completa e autossuficiente: o que varrer (ferramentas, filtros, páginas, documentos [n]), o que procurar e o que devolver.',
          ),
      }),
    )
    .min(1)
    .max(MAX_DELEGATED_TASKS),
});
export type DelegateArgs = z.output<typeof delegateArgsSchema>;

const parameters: Record<string, unknown> = {
  ...z.toJSONSchema(delegateArgsSchema, { io: 'input', target: 'draft-07' }),
};
delete parameters['$schema'];

export const DELEGATE_DEFINITION: ToolDefinition = {
  name: DELEGATE_TOOL,
  description: `Divide a pesquisa entre sub-pesquisadores que trabalham em paralelo, cada um com contexto próprio e as mesmas ferramentas de pesquisa (sem delegate). Dê de 1 a ${MAX_DELEGATED_TASKS} tarefas focadas e completas (por exemplo, "liste as obras citadas nos documentos das páginas offset 0 a 199 de find_text com entity X", ou "varra o documento [12] inteiro com find_text document e liste as obras citadas"). Cada um devolve só um relatório curto com as citações [n], que valem na sua resposta. Use quando a varredura for grande; junte os relatórios e tire as repetições.`,
  parameters,
};
