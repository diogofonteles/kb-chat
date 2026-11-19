/**
 * The v2 icon set (figma-recreation/redesign/src/lib.js, ICONS): 24×24, stroke 2, round caps.
 * Each icon is a list of shapes, drawn by UiIcon as SVG elements (no markup strings).
 * `fill: true` is a solid shape (no stroke).
 */
export interface IconShape {
  readonly t: 'path' | 'circle' | 'rect';
  readonly fill?: boolean;
  readonly d?: string;
  readonly cx?: string;
  readonly cy?: string;
  readonly r?: string;
  readonly x?: string;
  readonly y?: string;
  readonly width?: string;
  readonly height?: string;
  readonly rx?: string;
}

export const ICONS = {
  home: [{ t: 'path', d: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z' }],
  homeFill: [
    { t: 'path', fill: true, d: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z' },
  ],
  search: [
    { t: 'circle', cx: '11', cy: '11', r: '7' },
    { t: 'path', d: 'm20 20-4-4' },
  ],
  library: [{ t: 'path', d: 'M4 3v18M9 3v18M14 4l6 16' }],
  sparkle: [{ t: 'path', d: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z' }],
  sparkleFill: [
    { t: 'path', fill: true, d: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z' },
  ],
  plus: [{ t: 'path', d: 'M12 5v14M5 12h14' }],
  minus: [{ t: 'path', d: 'M5 12h14' }],
  more: [
    { t: 'circle', fill: true, cx: '5', cy: '12', r: '1.7' },
    { t: 'circle', fill: true, cx: '12', cy: '12', r: '1.7' },
    { t: 'circle', fill: true, cx: '19', cy: '12', r: '1.7' },
  ],
  play: [{ t: 'path', fill: true, d: 'M7 4.5v15l13-7.5z' }],
  pause: [
    {
      t: 'rect',
      fill: true,
      x: '6',
      y: '4',
      width: '4',
      height: '16',
      rx: '1',
    },
    {
      t: 'rect',
      fill: true,
      x: '14',
      y: '4',
      width: '4',
      height: '16',
      rx: '1',
    },
  ],
  shuffle: [
    {
      t: 'path',
      d: 'M3 7h3c4 0 6 10 10 10h5M3 17h3c1.7 0 3-1.5 4-3.5M14 9.5C15 8 16 7 18 7h3M18 4l3 3-3 3M18 14l3 3-3 3',
    },
  ],
  repeat: [
    {
      t: 'path',
      d: 'M4 12V9a3 3 0 0 1 3-3h13l-3-3M20 12v3a3 3 0 0 1-3 3H4l3 3',
    },
  ],
  chevDown: [{ t: 'path', d: 'm6 9 6 6 6-6' }],
  chevUp: [{ t: 'path', d: 'm6 15 6-6 6 6' }],
  type: [{ t: 'path', d: 'M5 7V5h14v2M12 5v14M9 19h6' }],
  chevLeft: [{ t: 'path', d: 'm15 6-6 6 6 6' }],
  chevRight: [{ t: 'path', d: 'm9 6 6 6-6 6' }],
  check: [{ t: 'path', d: 'm6 12.5 4 4 8-9' }],
  bookmark: [{ t: 'path', d: 'M6 3h12v18l-6-4-6 4z' }],
  bookmarkFill: [{ t: 'path', fill: true, d: 'M6 3h12v18l-6-4-6 4z' }],
  share: [{ t: 'path', d: 'M12 3v12M7 8l5-5 5 5M5 13v7h14v-7' }],
  rewind: [{ t: 'path', d: 'M4 12a8 8 0 1 0 2.3-5.6M4 4v5h5' }],
  forward: [{ t: 'path', d: 'M20 12a8 8 0 1 1-2.3-5.6M20 4v5h-5' }],
  queue: [{ t: 'path', d: 'M3 6h14M3 12h14M3 18h8M18 15v6M15 18h6' }],
  close: [{ t: 'path', d: 'M6 6l12 12M18 6 6 18' }],
  drag: [{ t: 'path', d: 'M4 9h16M4 15h16' }],
  cc: [
    { t: 'rect', x: '3', y: '5', width: '18', height: '14', rx: '2' },
    { t: 'path', d: 'M10.5 10a2 2 0 1 0 0 4M17 10a2 2 0 1 0 0 4' },
  ],
  sort: [{ t: 'path', d: 'M7 4v16M3 16l4 4 4-4M14 6h7M14 12h5M14 18h3' }],
  grid: [
    { t: 'rect', x: '4', y: '4', width: '6', height: '6' },
    { t: 'rect', x: '14', y: '4', width: '6', height: '6' },
    { t: 'rect', x: '4', y: '14', width: '6', height: '6' },
    { t: 'rect', x: '14', y: '14', width: '6', height: '6' },
  ],
  copy: [
    { t: 'rect', x: '8', y: '8', width: '12', height: '12', rx: '2' },
    { t: 'path', d: 'M16 8V4H4v12h4' },
  ],
  external: [{ t: 'path', d: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6' }],
  upload: [{ t: 'path', d: 'M12 16V4M7 9l5-5 5 5M4 20h16' }],
  settings: [
    { t: 'circle', cx: '12', cy: '12', r: '3' },
    {
      t: 'path',
      d: 'M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9 7 7M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1',
    },
  ],
  edit: [{ t: 'path', d: 'M4 20h4L19 9l-4-4L4 16z' }],
  doc: [{ t: 'path', d: 'M6 3h8l5 5v13H6zM14 3v5h5' }],
  timer: [
    { t: 'circle', cx: '12', cy: '13', r: '8' },
    { t: 'path', d: 'M12 9v4l2 2M9 2h6' },
  ],
  volume: [
    { t: 'path', d: 'M4 9h4l5-4v14l-5-4H4z' },
    { t: 'path', d: 'M16 9a4 4 0 0 1 0 6' },
  ],
  /** Muted: the speaker of `volume` with a cross where its wave was. */
  volumeOff: [
    { t: 'path', d: 'M4 9h4l5-4v14l-5-4H4z' },
    { t: 'path', d: 'm16 9 5 6M21 9l-5 6' },
  ],
  arrowRight: [{ t: 'path', d: 'M5 12h14M13 6l6 6-6 6' }],
  send: [{ t: 'path', d: 'M4 12 20 4l-6 16-3-7z' }],
  people: [
    { t: 'circle', cx: '9', cy: '8', r: '3.5' },
    {
      t: 'path',
      d: 'M2.5 20c.8-3.5 3.3-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.6.9 2.6 2.6 3 5.2',
    },
  ],
  bell: [{ t: 'path', d: 'M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4' }],
  filter: [{ t: 'path', d: 'M4 5h16l-6 8v6l-4-2v-4z' }],
  warn: [{ t: 'path', d: 'M12 3 2 20h20zM12 10v4M12 17h.01' }],
  info: [
    { t: 'circle', cx: '12', cy: '12', r: '9' },
    { t: 'path', d: 'M12 11v6M12 7.5h.01' },
  ],
  xcircle: [
    { t: 'circle', cx: '12', cy: '12', r: '9' },
    { t: 'path', d: 'm9 9 6 6M15 9l-6 6' },
  ],
  checkcircle: [
    { t: 'circle', cx: '12', cy: '12', r: '9' },
    { t: 'path', d: 'm8 12.5 3 3 5-6' },
  ],
  file: [{ t: 'path', d: 'M6 3h8l5 5v13H6zM14 3v5h5' }],
  music: [
    { t: 'path', d: 'M9 18V5l11-2v13' },
    { t: 'circle', cx: '6', cy: '18', r: '3' },
    { t: 'circle', cx: '17', cy: '16', r: '3' },
  ],
  list: [{ t: 'path', d: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' }],
  trash: [
    { t: 'path', d: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3' },
  ],
  eye: [
    { t: 'path', d: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z' },
    { t: 'circle', cx: '12', cy: '12', r: '3' },
  ],
  eyeOff: [
    {
      t: 'path',
      d: 'M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.5 7 10 7c1.8 0 3.4-.5 4.7-1.3',
    },
  ],
  chat: [{ t: 'path', d: 'M4 5h16v11H9l-5 4z' }],
  key: [
    { t: 'circle', cx: '8', cy: '15', r: '4' },
    { t: 'path', d: 'm11 12 9-9M16 7l3 3' },
  ],
  mic: [
    { t: 'rect', x: '9', y: '3', width: '6', height: '11', rx: '3' },
    { t: 'path', d: 'M5 11a7 7 0 0 0 14 0M12 18v3' },
  ],
  lock: [
    { t: 'rect', x: '5', y: '11', width: '14', height: '10', rx: '2' },
    { t: 'path', d: 'M8 11V7a4 4 0 0 1 8 0v4' },
  ],
  mail: [
    { t: 'rect', x: '3', y: '5', width: '18', height: '14', rx: '2' },
    { t: 'path', d: 'm3 7 9 6 9-6' },
  ],
  google: [
    { t: 'circle', cx: '12', cy: '12', r: '9' },
    { t: 'path', d: 'M12 12h8M12 3v0' },
  ],
  scissors: [
    { t: 'circle', cx: '6', cy: '6', r: '3' },
    { t: 'circle', cx: '6', cy: '18', r: '3' },
    { t: 'path', d: 'M8.5 7.5 20 18M8.5 16.5 20 6' },
  ],
  wave: [{ t: 'path', d: 'M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0' }],
  clock: [
    { t: 'circle', cx: '12', cy: '12', r: '9' },
    { t: 'path', d: 'M12 7v5l3 2' },
  ],
  refresh: [{ t: 'path', d: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7' }],
  link: [
    {
      t: 'path',
      d: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    },
  ],
  shield: [{ t: 'path', d: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z' }],
  cpu: [
    { t: 'rect', x: '6', y: '6', width: '12', height: '12', rx: '2' },
    {
      t: 'path',
      d: 'M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4',
    },
  ],
  keyboard: [
    { t: 'rect', x: '2', y: '6', width: '20', height: '12', rx: '2' },
    { t: 'path', d: 'M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10' },
  ],
  moon: [{ t: 'path', d: 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z' }],
  pin: [
    {
      t: 'path',
      fill: true,
      d: 'M14 3l7 7-3 1-4 4 1 4-2 2-4-4-5 5-1-1 5-5-4-4 2-2 4 1 4-4z',
    },
  ],
  expand: [{ t: 'path', d: 'M14 4h6v6M20 4l-7 7M10 20H4v-6M4 20l7-7' }],
  download: [
    { t: 'circle', cx: '12', cy: '12', r: '9' },
    { t: 'path', d: 'M12 7v9M8 12l4 4 4-4' },
  ],
  personAdd: [
    { t: 'circle', cx: '10', cy: '8', r: '4' },
    { t: 'path', d: 'M3 20c1-4 4-6 7-6s6 2 7 6M19 4v6M16 7h6' },
  ],
  folder: [{ t: 'path', d: 'M3 6h6l2 2h10v11H3z' }],
  book: [
    {
      t: 'path',
      d: 'M12 6.5C10 5 7 4.5 4 4.5v14c3 0 6 .5 8 2 2-1.5 5-2 8-2v-14c-3 0-6 .5-8 2zM12 6.5v14',
    },
  ],
  layers: [{ t: 'path', d: 'm12 3 9 5-9 5-9-5zM3 13l9 5 9-5' }],
  help: [
    { t: 'circle', cx: '12', cy: '12', r: '9' },
    {
      t: 'path',
      d: 'M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6v.6M12 17h.01',
    },
  ],
} as const satisfies Record<string, readonly IconShape[]>;

export type IconName = keyof typeof ICONS;
