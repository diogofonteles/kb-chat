import { provideZonelessChangeDetection } from '@angular/core';
import { fireEvent, render, screen } from '@testing-library/angular';
import { SeekSlider } from './seek-slider.js';

async function renderSlider(
  inputs: Partial<{
    currentMs: number;
    durationMs: number | null;
    disabled: boolean;
  }> = {},
) {
  const seekRequested = vi.fn();
  const view = await render(SeekSlider, {
    providers: [provideZonelessChangeDetection()],
    inputs: {
      currentMs: 754_000,
      durationMs: 3_735_000,
      bufferedEndMs: 900_000,
      ...inputs,
    },
    on: { seekRequested },
  });
  const slider = screen.getByRole('slider', { name: 'Posição' });
  const track = view.container.querySelector<HTMLElement>('.track');
  if (!track) throw new Error('no track');
  track.getBoundingClientRect = () => ({
    left: 100,
    width: 1000,
    top: 0,
    height: 44,
    right: 1100,
    bottom: 44,
    x: 100,
    y: 0,
    toJSON: () => '',
  });
  return { ...view, slider, track, seekRequested };
}

describe('SeekSlider (APG media seek slider)', () => {
  it('speaks the position in words, and the total only on focus', async () => {
    const { slider, fixture } = await renderSlider();
    expect(slider.getAttribute('aria-valuetext')).toBe(
      '12 minutos e 34 segundos',
    );
    expect(slider.getAttribute('aria-valuenow')).toBe('754');
    expect(slider.getAttribute('aria-valuemax')).toBe('3735');
    slider.focus();
    fireEvent.focus(slider);
    await fixture.whenStable();
    expect(slider.getAttribute('aria-valuetext')).toBe(
      '12 minutos e 34 segundos de 1 hora, 2 minutos e 15 segundos',
    );
  });

  it.each([
    ['ArrowRight', false, 5_000],
    ['ArrowUp', false, 5_000],
    ['ArrowLeft', false, -5_000],
    ['ArrowRight', true, 10_000],
    ['PageUp', false, 60_000],
    ['PageDown', false, -60_000],
  ])(
    'steps with %s (shift %s) by %i ms from the live position (AC-11)',
    async (key, shiftKey, delta) => {
      const { slider, seekRequested, fixture } = await renderSlider();
      const stepRequested = vi.fn();
      fixture.componentInstance.stepRequested.subscribe(stepRequested);
      const event = fireEvent.keyDown(slider, { key, shiftKey });
      expect(event).toBe(false); // preventDefault: no page scroll
      expect(stepRequested).toHaveBeenCalledWith(delta);
      expect(seekRequested).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['Home', 0],
    ['End', 3_735_000],
  ])('goes to the edge with %s', async (key, target) => {
    const { slider, seekRequested } = await renderSlider();
    fireEvent.keyDown(slider, { key });
    expect(seekRequested).toHaveBeenCalledWith(target);
  });

  it('leaves other keys to the page', async () => {
    const { slider, seekRequested } = await renderSlider();
    expect(fireEvent.keyDown(slider, { key: 'k' })).toBe(true);
    expect(seekRequested).not.toHaveBeenCalled();
  });

  it('seeks with a single click on the track, without dragging (WCAG 2.5.7)', async () => {
    const { track, seekRequested } = await renderSlider();
    fireEvent.pointerDown(track, { button: 0, clientX: 600, pointerId: 1 });
    fireEvent.pointerUp(track, { clientX: 600, pointerId: 1 });
    expect(seekRequested).toHaveBeenLastCalledWith(1_867_500);
  });

  it('shows the time next to the thumb while dragging and seeks at the end', async () => {
    const { track, seekRequested, fixture, container } = await renderSlider();
    fireEvent.pointerDown(track, { button: 0, clientX: 100, pointerId: 1 });
    fireEvent.pointerMove(track, { clientX: 1100, pointerId: 1 });
    await fixture.whenStable();
    expect(container.querySelector('.tip')?.textContent?.trim()).toBe(
      '1:02:15',
    );
    fireEvent.pointerUp(track, { clientX: 1100, pointerId: 1 });
    expect(seekRequested).toHaveBeenLastCalledWith(3_735_000);
  });

  it('shows the time under a mouse hovering, and hides it when it leaves', async () => {
    const { track, fixture, container, seekRequested } = await renderSlider();
    fireEvent.pointerMove(track, { clientX: 350, pointerType: 'mouse' });
    await fixture.whenStable();
    expect(container.querySelector('.tip')?.textContent?.trim()).toBe('15:33');
    fireEvent.pointerLeave(track);
    await fixture.whenStable();
    expect(container.querySelector('.tip')).toBeNull();
    expect(seekRequested).not.toHaveBeenCalled();
  });

  it('forgets a drag the browser cancelled', async () => {
    const { track, seekRequested, fixture, container } = await renderSlider();
    fireEvent.pointerDown(track, { button: 0, clientX: 600, pointerId: 1 });
    fireEvent.pointerCancel(track);
    await fixture.whenStable();
    expect(container.querySelector('.tip')).toBeNull();
    fireEvent.pointerUp(track, { clientX: 900 });
    expect(seekRequested).toHaveBeenCalledTimes(1);
  });

  it('does nothing before the duration is known, and says so', async () => {
    const { slider, track, seekRequested } = await renderSlider({
      durationMs: null,
    });
    expect(slider.getAttribute('aria-valuetext')).toBe(
      'áudio ainda não carregado',
    );
    expect(slider.getAttribute('aria-disabled')).toBe('true');
    fireEvent.keyDown(slider, { key: 'End' });
    fireEvent.pointerDown(track, { button: 0, clientX: 600 });
    expect(seekRequested).not.toHaveBeenCalled();
  });

  it('ignores the keyboard and the pointer when disabled', async () => {
    const { slider, track, seekRequested } = await renderSlider({
      disabled: true,
    });
    fireEvent.keyDown(slider, { key: 'End' });
    fireEvent.pointerDown(track, { button: 0, clientX: 600 });
    expect(seekRequested).not.toHaveBeenCalled();
  });

  it('ignores a right click', async () => {
    const { track, seekRequested } = await renderSlider();
    fireEvent.pointerDown(track, { button: 2, clientX: 600 });
    expect(seekRequested).not.toHaveBeenCalled();
  });
});
