import { SEARCH_MODES } from '@kb-chat/contracts';
import { z } from 'zod';
import type { ToolDefinition } from '../../ports/llm.js';

/** Hits per search the agent may ask for (ADR 0006; 30 since KBC-017). */
export const MAX_SEARCH_LIMIT = 30;
/** How far into the meaning search's candidates the agent may page (its cap is 50). */
export const MAX_SEARCH_OFFSET = 49;
/** find_text page sizes per output mode (KBC-017, ADR 0013): lines, or occurrences. */
export const GREP_PAGE = {
  files: { default: 20, max: 200 },
  count: { default: 200, max: 200 },
  content: { default: 30, max: 100 },
} as const;
export const GREP_MODES = ['files', 'count', 'content'] as const;
export type GrepMode = (typeof GREP_MODES)[number];
/** Characters around each occurrence in find_text's content mode. */
export const DEFAULT_CONTEXT_CHARS = 160;
export const MAX_CONTEXT_CHARS = 600;
/** read_document's page (KBC-017): its default stays the 12,000 characters of ADR 0006. */
export const MIN_READ_CHARS = 1_000;
export const MAX_READ_CHARS = 30_000;
/** list_sources' page. */
export const SOURCES_PAGE = { default: 40, max: 200 } as const;
/** Documents one read_documents call may read (KBC-011). */
export const MAX_BATCH_DOCUMENTS = 4;
/** Characters of each document's window in read_documents (KBC-011). */
export const BATCH_WINDOW_CHARS = 6_000;
/** Separator of alternative phrases in find_text. */
export const PHRASE_SEPARATOR = '|';

const documentRef = z
  .union([z.number().int().positive(), z.string().trim().min(1).max(1024)])
  .describe(
    'O número [n] de um documento já visto nesta pesquisa (preferível) ou o id (caminho) do documento.',
  );

/** The document filters of find_text and search_collection (KBC-017, ADR 0013). */
const filterShape = {
  entity: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .optional()
    .describe(
      'Só documentos cujas entidades do kb (autores, pessoas, obras) contêm este texto; acentos e maiúsculas não importam. Ex.: "José Laércio do Egito". Veja list_sources.',
    ),
  source: z
    .string()
    .trim()
    .min(2)
    .max(300)
    .optional()
    .describe(
      'Só documentos cuja origem (pasta do arquivo original) contém este texto, como "Temas-docs". Veja list_sources.',
    ),
  exclude: z
    .array(
      z.union([
        z.number().int().positive(),
        z.string().trim().min(2).max(1024),
      ]),
    )
    .max(100)
    .optional()
    .describe(
      'Deixa de fora: números [n] ou ids de documentos, um trecho da origem (ex.: "Livros") ou o nome exato de uma entidade.',
    ),
  subjects: z
    .array(z.string().min(1).max(200))
    .max(10)
    .optional()
    .describe('Limita a documentos destes assuntos (nomes de list_subjects).'),
};

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
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_SEARCH_LIMIT)
    .default(8)
    .describe(`Quantos documentos trazer (1 a ${MAX_SEARCH_LIMIT}).`),
  offset: z
    .number()
    .int()
    .min(0)
    .max(MAX_SEARCH_OFFSET)
    .default(0)
    .describe('Quantos resultados pular (página seguinte).'),
  ...filterShape,
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
    .describe(
      'Posição (em caracteres) de onde ler, como o "offset=" de uma leitura anterior ou a posição @ de find_text.',
    ),
  limit: z
    .number()
    .int()
    .min(MIN_READ_CHARS)
    .max(MAX_READ_CHARS)
    .optional()
    .describe(
      `Quantos caracteres ler (${MIN_READ_CHARS} a ${MAX_READ_CHARS}; padrão 12000).`,
    ),
});

export const readManyArgsSchema = z.object({
  documents: z
    .array(documentRef)
    .min(1)
    .max(MAX_BATCH_DOCUMENTS)
    .describe(
      `Até ${MAX_BATCH_DOCUMENTS} documentos: números [n] (preferível) ou ids.`,
    ),
  around: readArgsSchema.shape.around,
});

export const relatedArgsSchema = z.object({ document: documentRef });

const pageNumber = z.number().int().min(1).max(GREP_PAGE.files.max);

export const findArgsSchema = z
  .object({
    phrase: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .optional()
      .describe(
        'Texto exato a procurar (acentos e maiúsculas não importam), como "cinco princípios". Separe variantes com " | ": "livro | obra | bibliografia". Sem phrase, com entity ou source, lista todos os documentos do filtro.',
      ),
    output_mode: z
      .enum(GREP_MODES)
      .default('files')
      .describe(
        'files = uma linha por documento (padrão); count = ocorrências por documento, sem trechos; content = cada ocorrência com o texto em volta e a posição.',
      ),
    head_limit: pageNumber
      .optional()
      .describe(
        `Tamanho da página: linhas em files (padrão ${GREP_PAGE.files.default}) e count (padrão ${GREP_PAGE.count.default}), ocorrências em content (padrão ${GREP_PAGE.content.default}, até ${GREP_PAGE.content.max}).`,
      ),
    limit: pageNumber.optional().describe('O mesmo que head_limit.'),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Quantas linhas (ou ocorrências) pular: use o "offset=" da página anterior para continuar até o fim.',
      ),
    document: documentRef
      .optional()
      .describe(
        'Procura só neste documento, no corpo inteiro (para livros e compilações grandes): use com output_mode content.',
      ),
    context_chars: z
      .number()
      .int()
      .min(40)
      .max(MAX_CONTEXT_CHARS)
      .default(DEFAULT_CONTEXT_CHARS)
      .describe('Caracteres de texto em volta de cada ocorrência em content.'),
    ...filterShape,
  })
  .refine(
    (args) => args.phrase || (!args.document && (args.entity || args.source)),
    {
      error:
        'informe phrase, ou entity/source (sem document) para listar os documentos do filtro; document exige phrase',
      path: ['phrase'],
    },
  )
  .refine(
    (args) =>
      !args.document ||
      !(
        args.entity ||
        args.source ||
        args.exclude?.length ||
        args.subjects?.length
      ),
    {
      error:
        'document procura num só documento: não combine com entity, source, exclude ou subjects',
      path: ['document'],
    },
  );

export const sourcesArgsSchema = z.object({
  query: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe(
      'Parte do nome da pasta de origem ou da entidade; vazio lista as maiores.',
    ),
  kind: z
    .enum(['all', 'sources', 'entities'])
    .default('all')
    .describe(
      'sources = pastas de origem; entities = autores, pessoas e obras; all = os dois.',
    ),
  head_limit: z
    .number()
    .int()
    .min(1)
    .max(SOURCES_PAGE.max)
    .default(SOURCES_PAGE.default)
    .describe('Quantos itens de cada lista.'),
  offset: z.number().int().min(0).default(0).describe('Quantos itens pular.'),
});

export type ToolName =
  | 'search_collection'
  | 'find_text'
  | 'list_subjects'
  | 'list_sources'
  | 'read_document'
  | 'read_documents'
  | 'related_documents';

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
    'Busca por sentido e palavras no acervo. Devolve os documentos mais parecidos (no máximo 50 candidatos): [n], título, resumo do kb, trecho e assuntos, com offset para a página seguinte e os filtros entity, source e exclude. Refaça com outras palavras, sinônimos e outro modo quando não achar. Para listar TODOS os documentos de um autor, origem ou texto, use find_text.',
  find_text:
    'Procura um texto literal em TODOS os documentos do acervo (como o grep; acentos e maiúsculas não importam), sem limite de documentos: sempre informa o total de documentos e ocorrências e pagina com head_limit e offset até "Fim da lista". Filtros: entity (autor, pessoa ou obra), source (pasta de origem), exclude, subjects. Sem phrase, com entity ou source, lista todos os documentos do filtro. Com document, procura no corpo inteiro de um documento (livros enormes) e, em output_mode content, devolve cada ocorrência com a posição para read_document. Use para frases exatas, nomes, listas, números e para varrer o acervo por completo; separe variantes com " | ".',
  list_subjects:
    'Lista os assuntos (conceitos do kb) do acervo, com quantos documentos cada um tem.',
  list_sources:
    'Lista as pastas de origem dos documentos (de onde vieram os arquivos) e as entidades do kb (autores, pessoas, obras), com quantos documentos cada uma tem, filtradas por query. Use para descobrir os valores de source e entity de find_text.',
  read_document:
    'Lê um documento: resumo do kb, facetas e uma página do texto (padrão 12.000 caracteres, até 30.000 com limit), centrada em `around` ou a partir de `offset`. Sempre diz o tamanho total e o próximo offset, para ler um livro inteiro página por página.',
  read_documents: `Lê de uma vez até ${MAX_BATCH_DOCUMENTS} documentos: de cada um, o resumo do kb e uma janela de até 6.000 caracteres do texto, centrada em \`around\`. Use no lugar de read_document quando for ler mais de um documento.`,
  related_documents:
    'Lista as ligações do kb de um documento (é exemplo de, estende, relacionados, exemplos) como documentos numerados.',
};

const SCHEMAS: Record<ToolName, z.ZodType> = {
  search_collection: searchArgsSchema,
  find_text: findArgsSchema,
  list_subjects: subjectsArgsSchema,
  list_sources: sourcesArgsSchema,
  read_document: readArgsSchema,
  read_documents: readManyArgsSchema,
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
