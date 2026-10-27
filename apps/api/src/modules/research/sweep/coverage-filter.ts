import { foldName } from '../tool-output.js';

const WORD = 'cobertura';

/** The start of a line without its markdown dress (bold, heading, quote, bullet). */
const bare = (line: string): string =>
  foldName(line.replace(/^[\s*_#>`\-–—•]+/u, ''));

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

  push(delta: string): string {
    let out = '';
    for (const char of delta) out += this.take(char);
    return out;
  }

  /** The stream ended: a held line is shown unless it is a coverage line. */
  end(): string {
    const line = this.held;
    this.held = '';
    return bare(line).startsWith(WORD) ? '' : line;
  }

  private take(char: string): string {
    if (this.passing) {
      if (char === '\n') this.passing = false;
      return char;
    }
    if (char === '\n') {
      const line = this.held;
      this.held = '';
      return bare(line).startsWith(WORD) ? '' : `${line}\n`;
    }
    this.held += char;
    const start = bare(this.held);
    if (start.startsWith(WORD) || WORD.startsWith(start)) return '';
    this.passing = true;
    const line = this.held;
    this.held = '';
    return line;
  }
}
