/**
 * The safety net of auto-escalation (ADR 0009), a best-effort backstop behind the
 * `<<APROFUNDAR>>` marker: does a fast answer give up on the collection ("Os documentos do
 * acervo não dizem quais são…", "Eles de propósito não os nomeiam")?
 *
 * - Only the first sentence of the answer's first paragraph is read: an answer that gives
 *   up says so first; a gap noted after content ("Os textos centrais não dão os nomes.")
 *   is part of an answer.
 * - What is denied must be what was asked or a generic object ("isso", "a lista", "os
 *   nomes", "quais…"), or nothing at all: "Os textos não citam datas." is content.
 * - A sentence with a citation, or one that goes on to answer ("…, mas descreve [1]"), is
 *   content; so is a refusal ("de propósito") that cites a document.
 *
 * Text is folded (no accents, lower case) before matching.
 */

const fold = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const NEGATION = '(?:nao|nenhum|nenhuma|nem)';
/** An unstressed pronoun before the verb: "não os nomeiam", "não lhe dá". */
const CLITIC = '(?:(?:os|as|o|a|lhes?|se)\\s+)?';
/** What a collection does when it answers. */
const VERB =
  '(?:diz|dizem|disse|nomeia|nomeiam|nomeiem|lista|listam|enumera|enumeram|menciona|mencionam|traz|trazem|revela|revelam|cita|citam|explica|explicam|especifica|especificam|detalha|detalham|da|dao|apresenta|apresentam|identifica|identificam|define|definem|informa|informam|registra|registram|contem|conteem|aborda|abordam|fala|falam|trata|tratam|cobre|cobrem|responde|respondem|indica|indicam)';
/** The collection as the subject or the place. */
const COLLECTION =
  '(?:acervo|documentos?|textos?|fontes?|materia(?:l|is)|livros?|obras?|eles|elas)';
const PLACE = `(?:em|n[oa]s?|d[oa]s?)\\s+(?:\\S+\\s+)?${COLLECTION}\\b`;

/** A denied object that stands for the answer itself. */
const GENERIC =
  /^(?:(?:sobre|a respeito d\S*|acerca d\S*|de|da|do|das|dos|em)\s+)?(?:(?:o|a|os|as|um|uma|uns|umas|seus|suas|esses?|essas?|estes?|estas?)\s+)?(?:isso|isto|disso|disto|nisso|nisto|dele|dela|deles|delas|tal|tais|nada|resposta|quais?|quem|como|onde|quando|o que|nomes?|lista|listas|informac\S*|detalhes?|dados|mencao|referencia\S*|registros?|nenhum\S*)\b/;

interface Pattern {
  readonly regex: RegExp;
  /** Which part says what was denied: after the verb, or the subject before it. */
  readonly denied: 'rest' | 'subject';
}

const PATTERNS: readonly Pattern[] = [
  // "o acervo / os textos (…) não (os) nomeia(m) …", "o acervo não fala sobre isso"
  {
    regex: new RegExp(
      `\\b${COLLECTION}\\b[^.;:!?]{0,60}?\\b${NEGATION}\\s+${CLITIC}${VERB}\\b(?<rest>[^.;:!?]*)`,
    ),
    denied: 'rest',
  },
  // "nenhum (dos) documento(s) traz …", "nem os textos dizem …"
  {
    regex: new RegExp(
      `\\b${NEGATION}\\s+(?:(?:dos?|das?|os|as)\\s+)?${COLLECTION}\\b[^.;:!?]{0,40}?\\b${VERB}\\b(?<rest>[^.;:!?]*)`,
    ),
    denied: 'rest',
  },
  // "não (a) encontrei", "não foi possível encontrar", "não tenho dados …"
  {
    regex: new RegExp(
      `\\bnao\\s+${CLITIC}(?:encontrei|encontramos|localizei|localizamos|achei|tenho|temos|consegui (?:encontrar|localizar|achar)|foi possivel (?:encontrar|localizar|achar|identificar))\\b(?<rest>[^.;:!?]*)`,
    ),
    denied: 'rest',
  },
  // "não há (, nos documentos,) uma lista / informação …"
  {
    regex:
      /\bnao\s+(?:ha|existe|existem),?\s+(?:(?:em|n[oa]s?)\s+\S+(?:\s+d[oa]\s+\S+)?,?\s+)?(?<rest>[^.;:!?]*)/,
    denied: 'rest',
  },
  // "essa informação não está / consta / aparece no acervo"
  {
    regex: new RegExp(
      `(?<subject>[^.;!?]*?)\\bnao\\s+(?:esta|estao|consta|constam|aparece|aparecem|figura|figuram)\\s+${PLACE}`,
    ),
    denied: 'subject',
  },
  // "os princípios não são nomeados (nos textos)"
  {
    regex:
      /(?<subject>[^.;!?]*?)\bnao\s+(?:sao|e|foram|foi)\s+(?:nomead|citad|listad|revelad|mencionad|identificad|enumerad|explicad|tratad|abordad|descrit|detalhad|especificad|apresentad)\w*/,
    denied: 'subject',
  },
];

/** An explicit refusal of the texts: "de propósito", "deliberadamente", with a negation. */
const REFUSAL =
  /\b(?:de proposito|deliberadamente|propositalmente|intencionalmente)\b/;
const ANY_NEGATION = new RegExp(`\\b${NEGATION}\\b`);
const CITATION = /\[\d+\]/;
const CONTRAST_ANSWER =
  /\b(?:mas|porem|contudo|entretanto|no entanto|todavia)\b[^.]*\[\d+\]/;

const WORDS = /[a-z0-9]+/g;
/** Words of any question that say nothing about what was asked. */
const STOP_WORDS = new Set([
  'que',
  'qual',
  'quais',
  'quem',
  'como',
  'onde',
  'quando',
  'por',
  'porque',
  'para',
  'sobre',
  'com',
  'sem',
  'dos',
  'das',
  'nos',
  'nas',
  'uma',
  'umas',
  'uns',
  'sao',
  'foi',
  'acervo',
  'explique',
  'diga',
  'fale',
  'conte',
  'descreva',
  'mostre',
]);

/** The question's content words: what the answer may deny ("os cinco princípios ocultos"). */
function askedWords(question: string): Set<string> {
  return new Set(
    (fold(question).match(WORDS) ?? []).filter(
      (w) => w.length >= 3 && !STOP_WORDS.has(w),
    ),
  );
}

/** Articles, determiners and numbers before the head of a noun phrase. */
const DETERMINERS =
  /^(?:o|a|os|as|um|uma|uns|umas|seus|suas|esses?|essas?|estes?|estas?|[0-9]+|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|doze)$/;

/** "não apresentam o ritmo como castigo, mas como lei": a qualified object is content. */
const QUALIFIED = /\b(?:como|enquanto|mas|e sim|senao|porem)\b/;

/**
 * Is the denied thing the answer itself: nothing, a generic object, or what was asked?
 * Only the head of the denied noun phrase counts ("os cinco princípios ocultos" → "princípios
 * ocultos"), so "descanso ao ritmo" is not about the asked "ritmo".
 */
function deniesTheAnswer(denied: string, asked: Set<string>): boolean {
  const head = denied.trim().replace(/^[,:-]\s*/, '');
  if (!head || GENERIC.test(head)) return true;
  if (QUALIFIED.test(head)) return false;
  const words = (head.match(WORDS) ?? []).filter((w) => !DETERMINERS.test(w));
  // Only determiners ("não nomeia os cinco") stand for what was asked.
  if (words.length === 0) return true;
  return words.slice(0, 2).some((w) => asked.has(w));
}

/** The first paragraph that is not a heading, in sentences. */
function openingSentences(answer: string): string[] {
  const paragraph =
    answer
      .split(/\n\s*\n/u)
      .map((p) => p.trim())
      .find((p) => p && !p.startsWith('#')) ?? '';
  return paragraph.split(/(?<=[.!?])\s+/u).filter(Boolean);
}

/** The words that give up in a sentence, if it denies the answer itself. */
function givesUp(folded: string, asked: Set<string>): string | null {
  for (const { regex, denied } of PATTERNS) {
    const match = regex.exec(folded);
    const part = match?.groups?.[denied];
    if (match && part !== undefined && deniesTheAnswer(part, asked))
      return match[0].trim();
  }
  return null;
}

/** "Eles de propósito não os nomeiam": the texts refusing, in an uncited sentence. */
function refusalIn(sentences: readonly string[]): string | null {
  for (const sentence of sentences) {
    const folded = fold(sentence);
    if (CITATION.test(folded)) return null;
    const refusal = ANY_NEGATION.test(folded) ? REFUSAL.exec(folded) : null;
    if (refusal) return refusal[0];
  }
  return null;
}

/**
 * The words with which a fast answer gives up on the collection, or null. `question`
 * tells what the answer may deny; without it only generic objects count.
 */
export function absenceIn(answer: string, question = ''): string | null {
  const sentences = openingSentences(answer);
  const first = fold(sentences[0] ?? '');
  if (!first) return null;
  if (!CITATION.test(first) && !CONTRAST_ANSWER.test(first)) {
    const found = givesUp(first, askedWords(question));
    if (found) return found;
  }
  return refusalIn(sentences);
}

