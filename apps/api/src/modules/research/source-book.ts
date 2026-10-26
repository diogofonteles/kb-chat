import type { AnswerSource, Authorship, DocumentRef } from '@kb-chat/contracts';

/** A document as the tools meet it: catalog entries and hits carry their authorship (KBC-020). */
export interface SourceRef extends DocumentRef {
  readonly authorship?: Authorship;
  readonly author?: string | null;
}

/**
 * Numbers every document the agent meets during one turn (ADR 0006): the first time a
 * document shows up it gets the next n, and keeps it for the rest of the turn, so [n] in
 * tool outputs and in the answer always points to the same source.
 */
export class SourceBook {
  private readonly byId = new Map<string, AnswerSource>();
  private readonly byNumber = new Map<number, AnswerSource>();

  number(ref: SourceRef): number {
    const known = this.byId.get(ref.id);
    if (known) return known.n;
    const source: AnswerSource = {
      n: this.byId.size + 1,
      id: ref.id,
      title: ref.title,
      ...(ref.authorship ? { authorship: ref.authorship } : {}),
      ...(ref.author ? { author: ref.author } : {}),
    };
    this.byId.set(ref.id, source);
    this.byNumber.set(source.n, source);
    return source.n;
  }

  find(n: number): AnswerSource | undefined {
    return this.byNumber.get(n);
  }

  findById(id: string): AnswerSource | undefined {
    return this.byId.get(id);
  }

  get size(): number {
    return this.byId.size;
  }

  list(): AnswerSource[] {
    return [...this.byId.values()].map((source) => ({ ...source }));
  }
}
