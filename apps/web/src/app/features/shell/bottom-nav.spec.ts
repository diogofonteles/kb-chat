import { navTabs } from './bottom-nav.js';

const labels = (audio: Parameters<typeof navTabs>[0]) =>
  navTabs(audio).map((tab) => tab.label);

describe('the phone navigation under the audio rule (KBC-125 BR-2, AC-4)', () => {
  it('is Conversas · Buscar · Acervos without audio', () => {
    expect(labels(null)).toEqual(['Conversas', 'Buscar', 'Acervos']);
  });

  it('is Conversas · Buscar · Biblioteca · Fila with audio and the queue', () => {
    expect(labels({ queue: true, library: '/biblioteca' })).toEqual([
      'Conversas',
      'Buscar',
      'Biblioteca',
      'Fila',
    ]);
  });

  it('keeps Acervos in the place of Fila for who has no queue', () => {
    expect(labels({ queue: false, library: '/biblioteca' })).toEqual([
      'Conversas',
      'Buscar',
      'Biblioteca',
      'Acervos',
    ]);
  });

  it('names the tab Mídia when it opens Mídia (no library permission)', () => {
    expect(labels({ queue: false, library: '/midia' })).toEqual([
      'Conversas',
      'Buscar',
      'Mídia',
      'Acervos',
    ]);
  });

  it('has no library tab when the person cannot open the library', () => {
    expect(labels({ queue: true, library: null })).toEqual([
      'Conversas',
      'Buscar',
      'Acervos',
    ]);
  });
});
