import {
  NARRATION_HOLD_CHARS,
  preambleLength,
} from '../modules/research/index.js';

/**
 * The narration rule of ADR 0006 for a CLI that runs its own tool loop (ADR 0007): text
 * the model writes before a tool call ("Agora vou ler dois documentos…") is held and dropped
 * when the call comes; text that ends a message without tools, or passes the hold size, is
 * the answer. The answer's leading talk about the agent's own work is dropped too.
 */
export class CliAnswer {
  private held = '';
  private streaming = false;

  constructor(private readonly emit: (text: string) => void) {}

  text(delta: string): void {
    this.held += delta;
    if (this.streaming || this.held.length >= NARRATION_HOLD_CHARS)
      this.flush();
  }

  /** A tool call came: what was held was narration. Once streaming, the answer stays. */
  toolCalled(): void {
    if (!this.streaming) this.held = '';
  }

  /** The message ended without tools, or the CLI finished: what is held is the answer. */
  ended(): void {
    this.flush();
  }

  private flush(): void {
    const text = this.streaming
      ? this.held
      : this.held.slice(preambleLength(this.held));
    this.held = '';
    if (!text) return;
    this.streaming = true;
    this.emit(text);
  }
}
