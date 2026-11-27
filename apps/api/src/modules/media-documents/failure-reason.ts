/**
 * Why a document failed, as masters read it in Transcritores and on a track's page (KBC-191).
 * The Mac reports a tool's words; the known endings (a step ended as stuck by the Mac's watch,
 * a step past a limit) are said in Portuguese, naming the step, and the Mac's home folder never
 * shows. Anything else is the first line of what the tool said, as before.
 */

const REASON_CHARS = 200;
const FALLBACK = 'o kb falhou';

/** The Mac's watch ended a step that did no work (KBC-190): "kb: stalled, no work for 1200 s". */
const STALLED = /stalled, no work for (\d+) s/;
/** The old fixed limit: Python's TimeoutExpired, with the command it ran. */
const TIMED_OUT =
  /TimeoutExpired: Command '\[(.*?)\]' timed out after (\d+(?:\.\d+)?) seconds/;
/** A download's limit (KBC-190 BR-3): "yt-dlp: took more than 3600 s". */
const TOOK_MORE = /(?:^|\n)\s*([\w.-]+): took more than (\d+) s/;
/** The step kb was in, as the Mac prefixes it: "kb link: …". */
const KB_STEP = /^\s*kb ([a-z][\w-]*):/;
/** A home folder of the Mac (macOS) or of a Linux machine. */
const HOME = /\/(?:Users|home)\/[^/\s'"]+/g;

const minutes = (seconds: string): number => Math.round(Number(seconds) / 60);

const masked = (text: string): string => text.replace(HOME, '~');

const cut = (text: string): string =>
  text.length > REASON_CHARS ? `${text.slice(0, REASON_CHARS - 1)}…` : text;

/** The step a command ran: "kb link", "qmd embed", or the tool alone. */
function stepOfCommand(listed: string): string | null {
  const words = [...listed.matchAll(/'([^']*)'/g)].map((one) => one[1] ?? '');
  const tool = words[0]?.split('/').pop();
  if (!tool) return null;
  const sub = words[1];
  return sub && /^[a-z][\w-]*$/.test(sub) ? `${tool} ${sub}` : tool;
}

export const reasonOf = (error: string | null): string => {
  const text = error ?? '';
  const step = KB_STEP.exec(text)?.[1];
  const stalled = STALLED.exec(text);
  if (stalled?.[1]) {
    const name = step ? `kb ${step}` : 'do kb';
    return `o passo ${name} ficou ${minutes(stalled[1])} min sem trabalhar e foi interrompido`;
  }
  const timedOut = TIMED_OUT.exec(text);
  if (timedOut?.[1] !== undefined && timedOut[2]) {
    const name = stepOfCommand(timedOut[1]) ?? (step ? `kb ${step}` : 'do kb');
    return `o passo ${name} passou do limite de ${minutes(timedOut[2])} min`;
  }
  const tookMore = TOOK_MORE.exec(text);
  if (tookMore?.[1] && tookMore[2])
    return `o passo ${tookMore[1]} passou do limite de ${minutes(tookMore[2])} min`;
  const line = text
    .split('\n')
    .map((one) => one.trim())
    .find(Boolean);
  return cut(masked(line ?? FALLBACK));
};
