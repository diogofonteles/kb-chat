import type { ResearchEvent } from '@kb-chat/contracts';
import type {
  ResearchInput,
  ResearchRunnerPort,
} from '../ports/research-runner.js';

/** The runner of one turn and what to do once it is over. */
export interface StartedTurn {
  readonly runner: ResearchRunnerPort;
  readonly finish: () => void;
}

/**
 * A runner whose turn state (the paid fallback's meter) is made only when a turn starts and
 * dropped when it ends; a readiness check (`configured`) builds nothing (KBC-023 review).
 */
export class TurnScopedRunner implements ResearchRunnerPort {
  constructor(
    private readonly preview: ResearchRunnerPort,
    private readonly start: () => StartedTurn,
  ) {}

  get model(): string {
    return this.preview.model;
  }

  get billing(): ResearchRunnerPort['billing'] {
    return this.preview.billing;
  }

  configured(): boolean {
    return this.preview.configured();
  }

  async *run(input: ResearchInput): AsyncIterable<ResearchEvent> {
    const turn = this.start();
    try {
      yield* turn.runner.run(input);
    } finally {
      turn.finish();
    }
  }
}
