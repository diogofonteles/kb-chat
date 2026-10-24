/**
 * The safety net of auto-escalation (ADR 0009): does a fast answer give up on the
 * collection ("Os documentos do acervo não dizem quais são…", "Eles de propósito não os
 * nomeiam")? Only the answer's first paragraph is read, where an answer that gives up says
 * so. Text is folded (no accents, lower case) before matching.
 */

const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

/** Negations; "nem" covers "nem os textos trazem…". */
const NEGATION = '(?:nao|nenhum|nenhuma|nem)';

/** An unstressed pronoun between the negation and the verb: "não os nomeiam", "não lhe dá". */
const CLITIC = '(?:(?:os|as|o|a|lhes?|se)\\s+)?';

/** What a collection does when it answers: say, name, list, mention, bring, reveal… */
const VERB =
  '(?:diz|dizem|disse|nomeia|nomeiam|nomeiem|lista|listam|enumera|enumeram|menciona|mencionam|traz|trazem|revela|revelam|cita|citam|aparece|aparecem|consta|constam|explica|explicam|especifica|especificam|detalha|detalham|da|dao|apresenta|apresentam|identifica|identificam|define|definem|informa|informam|registra|registram)';

/** The collection as the subject (or "eles" for its texts, in a following sentence). */
const SUBJECT =
  '\\b(?:acervo|documentos?|textos?|fontes?|materia(?:l|is)|livros?|obras?|eles|elas)\\b';

const PATTERNS: readonly RegExp[] = [
  // "o acervo / os textos (…) não (os) nomeia(m)", "eles de propósito não os nomeiam"
  new RegExp(`${SUBJECT}[^.;:!?]{0,60}?\\b${NEGATION}\\s+${CLITIC}${VERB}\\b`),
  // "nenhum (dos) documento(s) (do acervo) traz", "nem os textos dizem"
  new RegExp(
    `\\b${NEGATION}\\s+(?:dos?\\s+|das?\\s+|os\\s+|as\\s+)?${SUBJECT}[^.;:!?]{0,40}?\\b${VERB}\\b`,
  ),
  // "não consta nos documentos", "não aparece no acervo": the place after the verb
  new RegExp(
    `\\bnao\\s+${CLITIC}${VERB}\\s+(?:em\\s+|n[oa]s?\\s+|d[oa]s?\\s+)(?:\\S+\\s+)?${SUBJECT}`,
  ),
  // "não (o) encontrei / localizei / achei" — the agent speaking of its own search
  /\bnao\s+(?:(?:o|a|os|as)\s+)?(?:encontrei|encontramos|localizei|localizamos|achei)\b/,
  // "não há informação / menção / registro / lista …"
  /\bnao\s+(?:ha|existe|existem)\s+(?:nenhuma?\s+)?(?:informac|mencao|registro|lista|referencia|indicac)/,
];

/** An explicit refusal of the texts: "de propósito", "deliberadamente" with a negation. */
const REFUSAL =
  /\b(?:de proposito|deliberadamente|propositalmente|intencionalmente)\b/;
const ANY_NEGATION = new RegExp(`\\b${NEGATION}\\b`);

const CITATION = /\[\d+\]/;
/** "…, mas descreve o ciclo [1]": a gap noted inside an answer that does answer. */
const CONTRAST_ANSWER =
  /\b(?:mas|porem|contudo|entretanto|no entanto|todavia)\b[^.]*\[\d+\]/;

/** The first paragraph that is not a heading, in sentences. */
function openingSentences(answer: string): string[] {
  const paragraph =
    answer
      .split(/\n\s*\n/u)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#')) ?? '';
  return paragraph.split(/(?<=[.!?])\s+/u).filter(Boolean);
}

/**
 * The words that give up in one sentence. An explicit refusal always counts; otherwise a
 * sentence that cites a document ("Segundo o texto, o ritmo não traz descanso [2].") or
 * goes on to answer ("…, mas descreve o ciclo [1]") is content, not a give-up.
 */
function givesUp(sentence: string): string | null {
  const folded = fold(sentence);
  if (CITATION.test(folded) || CONTRAST_ANSWER.test(folded)) return null;
  return PATTERNS.map((p) => p.exec(folded)).find(Boolean)?.[0] ?? null;
}

/** "Eles de propósito não os nomeiam": the texts refusing, anywhere in the paragraph. */
function refusalIn(sentences: readonly string[]): string | null {
  for (const sentence of sentences) {
    const folded = fold(sentence);
    const refusal = ANY_NEGATION.test(folded) ? REFUSAL.exec(folded) : null;
    if (refusal) return refusal[0];
  }
  return null;
}

/**
 * The words with which the answer's first paragraph gives up on the collection, or null.
 * A paragraph that already answered with a citation before that sentence is an answer.
 */
export function absenceIn(answer: string): string | null {
  const sentences = openingSentences(answer);
  const refusal = refusalIn(sentences);
  if (refusal) return refusal;
  for (const sentence of sentences) {
    const found = givesUp(sentence);
    if (found) return found;
    if (CITATION.test(sentence)) return null;
  }
  return null;
}
