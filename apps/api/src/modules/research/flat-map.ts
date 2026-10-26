/** What `flatText` drops: markdown emphasis and quote marks. */
const MARKDOWN = /[*_`#>]/;
const SPACE = /\s/;

/** A flattened text and, per character of it, the position it came from in the source. */
export interface FlatText {
  readonly flat: string;
  /** map[i] is the source position of flat[i] (a collapsed space points to its first blank). */
  readonly map: Int32Array;
}

interface FlatState {
  readonly chars: string[];
  readonly map: Int32Array;
  /** The first blank of a run not written yet, or -1. */
  pendingSpace: number;
}

function push(state: FlatState, char: string, from: number): void {
  state.map[state.chars.length] = from;
  state.chars.push(char);
}

function take(state: FlatState, char: string, at: number): void {
  if (MARKDOWN.test(char)) return;
  if (SPACE.test(char)) {
    if (state.chars.length > 0 && state.pendingSpace < 0)
      state.pendingSpace = at;
    return;
  }
  if (state.pendingSpace >= 0) push(state, ' ', state.pendingSpace);
  state.pendingSpace = -1;
  push(state, char, at);
}

/**
 * The same text as `flatText` of an already NFC-normalized source (one line, markdown
 * emphasis removed, blanks collapsed, trimmed), with a map back to the source positions:
 * a find_text occurrence in the flat text becomes an offset `read_document` can open
 * (KBC-017, ADR 0013). One pass, O(n).
 */
export function flatWithMap(source: string): FlatText {
  const state: FlatState = {
    chars: [],
    map: new Int32Array(source.length),
    pendingSpace: -1,
  };
  for (let at = 0; at < source.length; at += 1)
    take(state, source.charAt(at), at);
  return {
    flat: state.chars.join(''),
    map: state.map.subarray(0, state.chars.length),
  };
}
