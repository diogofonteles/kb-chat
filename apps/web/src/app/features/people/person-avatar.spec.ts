import { provideZonelessChangeDetection } from '@angular/core';
import { render } from '@testing-library/angular';
import { PersonAvatar, personInitials, personTone } from './person-avatar.js';

describe('personInitials', () => {
  it('takes the first and last names, one letter for one word, the address first letter', () => {
    expect(personInitials('Ana Souza')).toBe('AS');
    expect(personInitials('Eduardo  de Alves')).toBe('EA');
    expect(personInitials('Dono')).toBe('D');
    expect(personInitials('carla.mendes@exemplo.test')).toBe('C');
    expect(personInitials('   ')).toBe('?');
  });
});

describe('personTone', () => {
  it('gives a name a fixed colour of the palette and an address the grey', () => {
    const tone = personTone('Ana Souza');
    expect(tone).toBeGreaterThanOrEqual(1);
    expect(tone).toBeLessThanOrEqual(9);
    expect(personTone('ana souza')).toBe(tone);
    expect(personTone('carla.mendes@exemplo.test')).toBe(0);
    expect(personTone('')).toBe(0);
  });
});

describe('PersonAvatar', () => {
  const providers = [provideZonelessChangeDetection()];

  it('shows two initials on the colour of the name', async () => {
    const { container } = await render(PersonAvatar, {
      inputs: { name: 'Ana Souza' },
      providers,
    });
    const host = container as HTMLElement;
    expect(host.textContent?.trim()).toBe('AS');
    expect(host.getAttribute('data-tone')).toBe(
      String(personTone('Ana Souza')),
    );
    expect(host.classList.contains('ui-avatar')).toBe(true);
  });

  it('gives the owner the gold and one letter', async () => {
    const { container } = await render(PersonAvatar, {
      inputs: { name: 'Diogo Dono', owner: true },
      providers,
    });
    const host = container as HTMLElement;
    expect(host.textContent?.trim()).toBe('D');
    expect(host.getAttribute('data-tone')).toBe('owner');
  });
});
