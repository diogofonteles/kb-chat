import { readFileSync } from 'node:fs';

/** The same path from `src/` and from `dist/`. */
const VOCABULARY = new URL(
  '../../../assets/whisper-multilingual.tiktoken',
  import.meta.url,
);

/** tiktoken's split for this vocabulary, before byte pairs merge. */
const PIECES =
  /'s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+/gu;

type Ranks = ReadonlyMap<string, number>;

let loaded: Ranks | null = null;

/** Rank of each byte sequence, held as a latin1 string; read once, when first needed. */
function ranks(): Ranks {
  if (loaded) return loaded;
  const entries = readFileSync(VOCABULARY, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): [string, number] => {
      const [token = '', rank = ''] = line.split(' ');
      return [Buffer.from(token, 'base64').toString('latin1'), Number(rank)];
    });
  loaded = new Map(entries);
  return loaded;
}

/** The adjacent pair that merges first; -1 when none does. */
function bestPair(parts: readonly string[], vocabulary: Ranks): number {
  let best = -1;
  let lowest = Number.POSITIVE_INFINITY;
  for (let index = 0; index + 1 < parts.length; index++) {
    const rank = vocabulary.get(`${parts[index]}${parts[index + 1]}`);
    if (rank !== undefined && rank < lowest) {
      lowest = rank;
      best = index;
    }
  }
  return best;
}

/** Byte pair merging over one piece: how many tokens it ends as. */
function tokensOfPiece(piece: string, vocabulary: Ranks): number {
  const bytes = Buffer.from(piece, 'utf8').toString('latin1');
  if (vocabulary.has(bytes)) return 1;
  const parts = [...bytes];
  for (
    let pair = bestPair(parts, vocabulary);
    pair >= 0;
    pair = bestPair(parts, vocabulary)
  )
    parts.splice(pair, 2, `${parts[pair]}${parts[pair + 1]}`);
  return parts.length;
}

/**
 * Tokens of the term list as the transcriber's prompt: `build_prompt` joins the terms with
 * commas and ends with a period, and whisper encodes `" " + prompt`.
 */
export function countPromptTokens(terms: readonly string[]): number {
  const vocabulary = ranks();
  const prompt = ` ${terms.join(', ')}.`;
  return (prompt.match(PIECES) ?? []).reduce(
    (sum, piece) => sum + tokensOfPiece(piece, vocabulary),
    0,
  );
}
