import { SEARCH_MODES } from '@kb-chat/contracts';
import { z } from 'zod';
import type { ToolDefinition } from '../../ports/llm.js';

/** Hits per search the agent may ask for (ADR 0006). */
export const MAX_SEARCH_LIMIT = 15;

const documentRef = z
  .union([z.number().int().positive(), z.string().trim().min(1).max(1024)])
  .describe(
    'O número [n] de um documento já visto nesta pesquisa (preferível) ou o id (caminho) do documento.',
  );

export const searchArgsSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('Palavras ou frase a procurar, em português.'),
  mode: z
    .enum(SEARCH_MODES)
    .default('all')
    .describe(
      'exact = palavras exatas; semantic = pelo sentido; all = os dois combinados.',
    ),
  subjects: z
    .array(z.string().min(1).max(200))
    .max(10)
    .optional()
    .describe('Limita a documentos destes assuntos (nomes de list_subjects).'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .default(8)
    .describe(`Quantos documentos trazer (1 a ${MAX_SEARCH_LIMIT}).`),
});

export const subjectsArgsSchema = z.object({
  query: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe('Parte do nome do assunto; vazio lista os maiores assuntos.'),
});

export const readArgsSchema = z.object({
  document: documentRef,
  around: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Palavra ou frase: o trecho mostrado fica em volta das ocorrências dela.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Posição (em caracteres) de onde continuar a leitura.'),
});

export const relatedArgsSchema = z.object({ document: documentRef });

export type ToolName =
  'search_collection' | 'list_subjects' | 'read_document' | 'related_documents';

/** JSON Schema of the arguments, without the `$schema` key some providers refuse. */
const toParameters = (schema: z.ZodType): Record<string, unknown> => {
  const parameters: Record<string, unknown> = {
    ...z.toJSONSchema(schema, { io: 'input', target: 'draft-07' }),
  };
  delete parameters['$schema'];
  return parameters;
};

const DESCRIPTIONS: Record<ToolName, string> = {
  search_collection:
    'Busca no acervo. Devolve, por documento: [n], título, resumo do kb, trecho e assuntos. Refaça com outras palavras, sinônimos e outro modo quando não achar.',
  list_subjects:
    'Lista os assuntos (conceitos do kb) do acervo, com quantos documentos cada um tem.',
  read_document:
    'Lê um documento: resumo do kb, facetas e uma janela de até 12.000 caracteres do texto, centrada em `around` ou a partir de `offset`.',
  related_documents:
    'Lista as ligações do kb de um documento (é exemplo de, estende, relacionados, exemplos) como documentos numerados.',
};

const SCHEMAS: Record<ToolName, z.ZodType> = {
  search_collection: searchArgsSchema,
  list_subjects: subjectsArgsSchema,
  read_document: readArgsSchema,
  related_documents: relatedArgsSchema,
};

/** The research tools as the model sees them (ADR 0006); the same for every provider. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = (
  Object.keys(SCHEMAS) as ToolName[]
).map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  parameters: toParameters(SCHEMAS[name]),
}));
