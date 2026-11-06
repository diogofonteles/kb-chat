/**
 * Where a citation or a chip sits in the conversation: the answer it belongs to and its
 * place among that answer's links and buttons. The element itself may be drawn anew while
 * the reading panel is open (the history bringing the same conversation back, a late save),
 * so closing the panel finds the focus's way back by place, not by the old node (AC-12).
 */
export interface TriggerPlace {
  /** The answer's place among the conversation's answers. */
  readonly message: number;
  /** The control's place among that answer's links and buttons. */
  readonly control: number;
}

const ANSWER = 'app-research-message';
const CONTROLS = 'a[href], button';

export function placeOf(
  trigger: HTMLElement | null,
  root: ParentNode,
): TriggerPlace | null {
  const answer = trigger?.closest(ANSWER);
  if (!trigger || !answer) return null;
  const message = [...root.querySelectorAll(ANSWER)].indexOf(answer);
  const control = [...answer.querySelectorAll(CONTROLS)].indexOf(trigger);
  return message < 0 || control < 0 ? null : { message, control };
}

/** The control at that place now; null when the conversation no longer has it. */
export function controlAt(
  place: TriggerPlace | null,
  root: ParentNode,
): HTMLElement | null {
  if (!place) return null;
  const answer = root.querySelectorAll(ANSWER)[place.message];
  const control =
    answer?.querySelectorAll<HTMLElement>(CONTROLS)[place.control];
  return control ?? null;
}
