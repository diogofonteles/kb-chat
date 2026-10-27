import { foldName } from '../tool-output.js';

const WORD = 'cobertura';

/** The start of a line without its markdown dress (bold, heading, quote, bullet). */
const bare = (line: string): string =>
  foldName(line.replace(/^(?:[\s*_#>`|\-–—•]|\d+[.)])+/u, ''));

/** Only list numbers, bullets and markdown so far: the line may still be a coverage line. */
const ONLY_PREFIX = /^[\s*_#>`|\-–—•\d.)]*$/u;

/** A line that is only a coverage heading ("## Cobertura", "**Cobertura:**"). */
const isHeading = (start: string): boolean =>
  /^cobertura[\s:*_#]*$/u.test(start);

/**
 * Takes the model's own coverage lines out of a streamed answer (KBC-030, ADR 0021): the
 * coverage is the app's, measured, never the model's claim. A line is held only while it
 * may still turn out to begin with "Cobertura"; any other text passes at once.
 */
export class CoverageLineFilter {
  /** The current line, held while it could be a coverage line. */
  private held = '';
  /** The current line proved not to be one: the rest of it passes. */
  private passing = false;
  /** Under a coverage heading: its lines are dropped up to the next blank line. */
  private section = false;

  push(delta: string): string {
    let out = '';
    for (const char of delta) out += this.take(char);
    return out;
  }

  /** The stream ended: a held line is shown unless it is a coverage line. */
  end(): string {
    const line = this.held;
    this.held = '';
    return this.section || bare(line).startsWith(WORD) ? '' : line;
  }

  /** A whole line: dropped when it claims coverage or belongs to a coverage section. */
  private endLine(): string {
    const line = this.held;
    this.held = '';
    const start = bare(line);
    // The section ends at a blank line, which goes with it.
    if (this.section) {
      this.section = start !== '';
      return '';
    }
    if (!start.startsWith(WORD)) return `${line}\n`;
    this.section = isHeading(start);
    return '';
  }

  private take(char: string): string {
    if (this.passing) {
      if (char === '\n') this.passing = false;
      return char;
    }
    if (char === '\n') return this.endLine();
    this.held += char;
    if (this.section) return '';
    const start = bare(this.held);
    const undecided =
      ONLY_PREFIX.test(this.held) ||
      start.startsWith(WORD) ||
      WORD.startsWith(start);
    if (undecided) return '';
    this.passing = true;
    const line = this.held;
    this.held = '';
    return line;
  }
}
