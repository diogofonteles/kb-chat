import { provideZonelessChangeDetection } from '@angular/core';
import { render } from '@testing-library/angular';
import { VoiceTag } from './voice-tag.js';

describe('VoiceTag (KBC-064 AC-8)', () => {
  it('reads "Voz N" and hides the coloured shape from screen readers', async () => {
    const { container } = await render(VoiceTag, {
      inputs: { voice: 7 },
      providers: [provideZonelessChangeDetection()],
    });
    expect(container.textContent?.trim()).toBe('Voz 7');
    const mark = container.querySelector('.mark');
    expect(mark?.getAttribute('aria-hidden')).toBe('true');
    expect(mark?.getAttribute('data-shape')).toBe('square');
    expect(mark?.classList.contains('hollow')).toBe(true);
  });

  it('draws a plain dot when asked (the Sobre panel), keeping the text and the tone', async () => {
    const { container } = await render(VoiceTag, {
      inputs: { voice: 2, round: true },
      providers: [provideZonelessChangeDetection()],
    });
    expect(container.textContent?.trim()).toBe('Voz 2');
    const mark = container.querySelector<HTMLElement>('.mark');
    expect(mark?.getAttribute('data-shape')).toBe('circle');
    expect(mark?.style.getPropertyValue('--voice-color')).toBe(
      'var(--color-voice-2)',
    );
  });
});
