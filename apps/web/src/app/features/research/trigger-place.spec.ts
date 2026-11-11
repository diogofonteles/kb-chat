import { controlAt, placeOf } from './trigger-place.js';

const ANSWER = `
  <app-research-message>
    <div class="answer"><p>Texto <a href="#fonte-1">[1]</a> e <a href="#fonte-1">[1]</a></p></div>
    <button type="button" class="source">♪ O que é o ritmo?</button>
  </app-research-message>`;

function conversation(): HTMLElement {
  const root = document.createElement('section');
  root.innerHTML = ANSWER + ANSWER;
  document.body.append(root);
  return root;
}

describe('trigger place (KBC-099 AC-12, QA BUG-2)', () => {
  afterEach(() => document.body.replaceChildren());

  it('finds the same citation again after the answers are drawn anew', () => {
    const root = conversation();
    const second = root.querySelectorAll('app-research-message')[1];
    const citation = second?.querySelectorAll<HTMLElement>('a')[1] ?? null;
    const place = placeOf(citation, root);
    expect(place).toEqual({ message: 1, control: 1 });

    root.innerHTML = ANSWER + ANSWER;
    expect(citation?.isConnected).toBe(false);
    const again = controlAt(place, root);
    expect(again).not.toBeNull();
    expect(again).toBe(
      root
        .querySelectorAll('app-research-message')[1]
        ?.querySelectorAll('a')[1],
    );
  });

  it('finds the chip again by its place', () => {
    const root = conversation();
    const chip = root.querySelector<HTMLElement>('button.source');
    const place = placeOf(chip, root);
    expect(place).toEqual({ message: 0, control: 2 });
    root.innerHTML = ANSWER;
    expect(controlAt(place, root)?.textContent).toContain('O que é o ritmo?');
  });

  it('has no place outside an answer, and nothing when the answer is gone', () => {
    const root = conversation();
    const outside = document.createElement('button');
    root.append(outside);
    expect(placeOf(outside, root)).toBeNull();
    expect(placeOf(null, root)).toBeNull();
    expect(controlAt(null, root)).toBeNull();
    expect(controlAt({ message: 5, control: 0 }, root)).toBeNull();
    expect(controlAt({ message: 0, control: 9 }, root)).toBeNull();
  });
});
