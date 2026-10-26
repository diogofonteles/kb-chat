import type { AgentMessage } from '../../ports/llm.js';
import type { SourceBook } from './source-book.js';
import { oneLine } from './tool-output.js';

/** How a compacted tool result starts: the model is told what happened to it. */
export const COMPACTED_MARK = '[resultado compactado]';
/** The most recent tool results kept whole (ADR 0013). */
export const KEEP_TOOL_RESULTS = 6;
const MAX_REFS = 300;
const FIRST_LINE_CHARS = 400;

const isCompacted = (content: string): boolean =>
  content.startsWith(COMPACTED_MARK);

/** The [n] a tool result listed, in order, once each. */
function refsOf(content: string): string[] {
  const refs = [...content.matchAll(/^\[(\d+)\]|^- \[(\d+)\]/gm)].map(
    (match) => match[1] ?? match[2] ?? '',
  );
  return [...new Set(refs.filter(Boolean))].map((n) => `[${n}]`);
}

/** A tool result reduced to its first line (the totals) and the documents it listed. */
export function compactedText(content: string): string {
  const first = oneLine(content.split('\n')[0] ?? '', FIRST_LINE_CHARS);
  const refs = refsOf(content);
  const shown = refs.slice(0, MAX_REFS).join(' ');
  const more =
    refs.length > MAX_REFS ? ` e mais ${refs.length - MAX_REFS}` : '';
  const listed =
    refs.length > 0 ? ` Documentos listados: ${shown}${more}.` : '';
  return `${COMPACTED_MARK} ${first}${listed} (Texto resumido para caber no contexto; chame a ferramenta de novo se precisar dele.)`;
}

const ledgerOf = (book: SourceBook): string =>
  `${book.size} documento(s) numerados até aqui${book.size > 0 ? ` ([1] a [${book.size}])` : ''}; os números continuam valendo. Resultados antigos de ferramenta foram resumidos; suas anotações da lista parcial continuam acima.`;

const LEDGER_START = '\nRegistro: ';

/** The tool results older than the last `keep` that are not compacted yet, in order. */
function toCompact(messages: readonly AgentMessage[], keep: number): number[] {
  const toolIndexes = messages.flatMap((m, i) =>
    m.role === 'tool' ? [i] : [],
  );
  return toolIndexes
    .slice(0, Math.max(0, toolIndexes.length - keep))
    .filter((i) => !isCompacted(messages[i]?.content ?? ''));
}

/** A compacted result without the ledger an earlier pass appended (only the newest stays). */
const withoutLedger = (content: string): string => {
  const at = content.indexOf(LEDGER_START);
  return at < 0 ? content : content.slice(0, at);
};

/**
 * Auto-compaction of a long research turn (KBC-017, ADR 0013): every tool result older
 * than the last `keep` becomes a short entry (its totals and the [n] it listed); the first
 * one compacted now also carries a ledger of the numbered documents. The model's own text,
 * its notes of the running list, stays. Deterministic: no model call, nothing spent.
 */
export function compactToolResults(
  messages: readonly AgentMessage[],
  { book, keep = KEEP_TOOL_RESULTS }: { book: SourceBook; keep?: number },
): { messages: AgentMessage[]; compacted: number } {
  const fresh = toCompact(messages, keep);
  if (fresh.length === 0) return { messages: [...messages], compacted: 0 };
  const first = fresh[0];
  const result = messages.map((message, i) => {
    if (message.role !== 'tool') return message;
    if (i === first)
      return {
        ...message,
        content: `${compactedText(message.content)}${LEDGER_START}${ledgerOf(book)}`,
      };
    if (fresh.includes(i))
      return { ...message, content: compactedText(message.content) };
    return isCompacted(message.content)
      ? { ...message, content: withoutLedger(message.content) }
      : message;
  });
  return { messages: result, compacted: fresh.length };
}
