/**
 * Why a document failed, as masters read it in Transcritores and on a track's page (KBC-191).
 * The Mac reports a tool's words; the known endings (a step ended as stuck by the Mac's watch,
 * a step past a limit, kb out of budget) are said in Portuguese, naming the step, and the
 * Mac's home folder never shows. Anything else is the first line of what the tool said.
 */

const REASON_CHARS = 200;
const FALLBACK = 'o kb falhou';
const SYNC_FALLBACK = 'a sincronização falhou';

/** The Mac's watch ended a step that did no work (KBC-190): "kb: stalled, no work for 1200 s". */
const STALLED = /^[ \t]*([\w.-]+): stalled, no work for (\d+) s/m;
/** The old fixed limit: Python's TimeoutExpired, with the command it ran. */
const TIMED_OUT =
  /TimeoutExpired: Command '\[(.*?)\]' timed out after (\d+(?:\.\d+)?) seconds/;
/** A download's limit (KBC-190 BR-3; doc-ingest only, never a track): "yt-dlp: took more than 3600 s". */
const TOOK_MORE = /^[ \t]*([\w.-]+): took more than (\d+) s/m;
/** The step kb was in, as the Mac begins its words: "kb link: …", "kb topic new: …". */
const KB_STEP = /^\s*kb ([a-z][\w-]*(?: [a-z][\w-]*)*):/;
/** A home folder of the Mac (macOS) or of a Linux machine. */
const HOME = /\/(?:Users|home)\/[^/\s'"]+/g;
const TOOL = /^[\w.-]+$/;
const SYNC_LINE = /^sync-vault:/;

/** What the app and the Mac write in English, said as masters read it. */
const KNOWN: Readonly<Record<string, string>> = {
  'kb failed': FALLBACK,
  'kb left it undecided (budget reached): re-run':
    'o kb não decidiu: o orçamento acabou; tente de novo',
};

/** Whole minutes, never "0 min". */
const minutes = (seconds: string): number =>
  Math.max(1, Math.round(Number(seconds) / 60));

const masked = (text: string): string => text.replace(HOME, '~');

const cut = (text: string): string =>
  text.length > REASON_CHARS ? `${text.slice(0, REASON_CHARS - 1)}…` : text;

/** The step a command ran ("kb link", "qmd embed"), or null when it is not a plain list. */
function stepOfCommand(listed: string): string | null {
  const words = [...listed.matchAll(/'([^']*)'/g)].map((one) => one[1] ?? '');
  const tool = words[0]?.split('/').pop() ?? '';
  if (!TOOL.test(tool)) return null;
  const sub = words[1];
  return sub && /^[a-z][\w-]*$/.test(sub) ? `${tool} ${sub}` : tool;
}

/** The stuck tool, and the kb step it ran inside when it is not kb itself. */
function stuckName(tool: string, step: string | undefined): string {
  if (tool !== 'kb') return step ? `${tool} (do kb ${step})` : tool;
  return step ? `kb ${step}` : 'do kb';
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((one) => one.trim())
    .filter(Boolean);

export const reasonOf = (error: string | null): string => {
  const text = error ?? '';
  const step = KB_STEP.exec(text)?.[1];
  const stalled = STALLED.exec(text);
  if (stalled?.[1] && stalled[2])
    return `o passo ${stuckName(stalled[1], step)} ficou ${minutes(stalled[2])} min sem trabalhar e foi interrompido`;
  const timedOut = TIMED_OUT.exec(text);
  if (timedOut?.[1] !== undefined && timedOut[2]) {
    const name = stepOfCommand(timedOut[1]) ?? (step ? `kb ${step}` : 'do kb');
    return `o passo ${name} passou do limite de ${minutes(timedOut[2])} min`;
  }
  const tookMore = TOOK_MORE.exec(text);
  if (tookMore?.[1] && tookMore[2])
    return `o passo ${tookMore[1]} passou do limite de ${minutes(tookMore[2])} min`;
  const line = lines(text)[0] ?? FALLBACK;
  return cut(masked(KNOWN[line] ?? line));
};

/**
 * Why the Mac's sync with production failed (KBC-191 review F10): sync-vault's own last word
 * when it said one, else the last line of the output (rsync's, ssh's), never the home folder.
 */
export const syncReasonOf = (detail: string): string => {
  const said = lines(detail);
  const line =
    said.filter((one) => SYNC_LINE.test(one)).at(-1) ??
    said.at(-1) ??
    SYNC_FALLBACK;
  return cut(masked(line));
};
