import type { ResearchEvent } from '@kb-chat/contracts';
import { preambleLength } from './answer-preamble.js';
import { withoutMarker } from './escalation.js';

/**
 * Most characters held at the start of a segment so a preamble about the agent's own work
 * ("Tenho tudo o que preciso.") can be recognized as a whole: one sentence (ADR 0009).
 */
export const PREAMBLE_WINDOW_CHARS = 120;

/** A sentence is complete at its final mark followed by a space, or at a line break. */
const SENTENCE_END = /[.?:;]\s|\n/u;

/**
 * A first sentence that announces research instead of answering ("Vou buscar no acervo…",
 * "Deixe-me ler os dois documentos."). Such a segment is held until its model call ends, so
 * the reader does not see it flash and be retracted when the tool call comes.
 */
const NARRATION =
  /^(?:(?:agora|primeiro|então|ok|certo|bem)[,.]?\s+)?(?:vou|deixe-me|deixa eu|preciso|vamos|let me|i'll|i will)\s+(?:\S+\s+){0,2}?(?:buscar|procurar|pesquisar|ler|verificar|consultar|olhar|checar|examinar|investigar|aprofundar|conferir|search|look|read|check|find)/iu;

/** The start of the escalation marker (ADR 0009): held whole, the runner decides. */
const MARKER_START = /^<(?:<|$)/u;

type Events = ResearchEvent[];

/**
 * The answer text of one research turn as it streams (ADR 0009, replacing ADR 0006's
 * 800-character hold). Each model call writes one segment. Its text is shown at once, after
 * at most one sentence held to drop a preamble; when that call then asks for tools, the
 * segment was the agent thinking aloud and a `retract` takes it back out of the answer.
 * Shared by the in-API loop and the subscription CLIs, which report the same three moments.
 */
export class AnswerStream {
  private segment = 0;
  private held = '';
  private seen = false;
  private started = false;
  private narration = false;
  /** The escalation marker began in this segment: nothing more is shown until it ends. */
  private markerHeld = false;
  private readonly shownText = new Map<number, string>();

  /** The answer as the reader sees it now (segments not retracted). */
  get shown(): string {
    return [...this.shownText.values()].join('');
  }

  /** Everything the current model call wrote so far, shown or held. */
  get current(): string {
    return (this.shownText.get(this.segment) ?? '') + this.held;
  }

  /** Answer text from the current model call. */
  text(delta: string): Events {
    if (!delta) return [];
    this.held += delta;
    this.seen = true;
    if (this.started) return this.release();
    return this.narration ? [] : this.begin(false);
  }

  /** The current model call asked for tools: what it wrote so far was not the answer. */
  toolCalled(): Events {
    const events: Events = this.started
      ? [{ type: 'retract', segment: this.segment }]
      : [];
    this.shownText.delete(this.segment);
    this.next();
    return events;
  }

  /** The current model call ended without tools: what it holds is the answer. */
  ended(): Events {
    this.narration = false;
    const events = this.started
      ? this.emit(withoutMarker(this.takeHeld()))
      : this.begin(true);
    this.next();
    return events;
  }

  /** Text of the server's own (an empty answer's notice), in a segment of its own. */
  say(text: string): Events {
    this.next();
    this.started = true;
    const events = this.emit(text);
    this.next();
    return events;
  }

  private begin(ended: boolean): Events {
    const rest = this.held.slice(preambleLength(this.held));
    const sentence = SENTENCE_END.test(rest);
    if (!ended && !sentence && rest.length < PREAMBLE_WINDOW_CHARS) return [];
    if (!ended && (NARRATION.test(rest) || MARKER_START.test(rest))) {
      this.narration = true;
      return [];
    }
    this.held = rest;
    if (!rest) return [];
    this.started = true;
    return ended ? this.emit(withoutMarker(this.takeHeld())) : this.release();
  }

  /**
   * Shows what is held, except from a `<` on: it may open the escalation marker, which the
   * reader never sees (ADR 0009). A `<` not followed by another is shown with what follows.
   */
  private release(): Events {
    if (this.markerHeld) return [];
    let shown = '';
    for (;;) {
      const at = this.held.indexOf('<');
      shown += at < 0 ? this.held : this.held.slice(0, at);
      this.held = at < 0 ? '' : this.held.slice(at);
      if (this.held.length < 2) break;
      if (this.held.startsWith('<<')) {
        this.markerHeld = true;
        break;
      }
      shown += '<';
      this.held = this.held.slice(1);
    }
    return this.emit(shown);
  }

  private takeHeld(): string {
    const text = this.held;
    this.held = '';
    return text;
  }

  private emit(text: string): Events {
    if (!text) return [];
    const segment = this.segment;
    this.shownText.set(segment, (this.shownText.get(segment) ?? '') + text);
    return [{ type: 'token', text, segment }];
  }

  /** A new model call writes a new segment; an empty one keeps its number. */
  private next(): void {
    if (this.seen || this.started) this.segment += 1;
    this.held = '';
    this.seen = false;
    this.started = false;
    this.narration = false;
    this.markerHeld = false;
  }
}
