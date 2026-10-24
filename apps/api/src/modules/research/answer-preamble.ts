/**
 * Leading sentences in which the model talks about its own work instead of answering
 * ("Agora tenho uma imagem completa…", "Vou compor a resposta.") and a leading "---" line.
 * Deliberately narrow: each pattern needs the process words together, a sentence with a
 * citation or a quote is content, and only the very start of the answer is looked at.
 */
const PREAMBLE_PATTERNS: readonly RegExp[] = [
  /^(agora |ótimo|perfeito|certo)?[^.\n[“"]{0,80}(tenho|reuni|encontrei)[^.\n[“"]{0,120}(informaç|o que preciso|tudo|imagem completa)[^.\n[“"]*[.:!]\s*/iu,
  /^vou (compor|escrever|responder|organizar)[^.\n[“"]*[.:!]\s*/iu,
  /^-{3,}[ \t]*(?:\n\s*|$)/u,
];

/** "Tenho tudo. Vou compor a resposta.\n\n---\n\n" is three pieces; more is not a preamble. */
const MAX_PIECES = 4;

const leadingSpace = (text: string): number =>
  text.length - text.trimStart().length;

/** How many leading characters of the answer are preamble (and leading blank space). */
export function preambleLength(text: string): number {
  let offset = leadingSpace(text);
  for (let piece = 0; piece < MAX_PIECES; piece += 1) {
    const rest = text.slice(offset);
    const match = PREAMBLE_PATTERNS.map((pattern) => pattern.exec(rest)).find(
      (found) => found !== null,
    );
    if (!match) break;
    offset += match[0].length;
    offset += leadingSpace(text.slice(offset));
  }
  return offset;
}
