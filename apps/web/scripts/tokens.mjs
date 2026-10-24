// Generates src/styles/colors.generated.css from the DTCG tokens (src/styles/tokens.json).
// `--check` fails when the generated file is out of date (run by `lint`).
import { readFileSync, writeFileSync } from 'node:fs';

const tokensPath = new URL('../src/styles/tokens.json', import.meta.url);
const outputPath = new URL(
  '../src/styles/colors.generated.css',
  import.meta.url,
);
const { color } = JSON.parse(readFileSync(tokensPath, 'utf8'));

const declarations = (theme) =>
  Object.entries(color[theme])
    .map(([name, token]) => `  --color-${name}: ${token.$value};`)
    .join('\n');

const css = `/* Generated from tokens.json by scripts/tokens.mjs — do not edit by hand. */
:root,
[data-theme='light'] {
${declarations('light')}
}

@media (prefers-color-scheme: dark) {
  :root:not([data-theme='light']):not([data-theme='esoteric']) {
${declarations('dark').replace(/^/gm, '  ')}
  }
}

[data-theme='dark'] {
${declarations('dark')}
}

[data-theme='esoteric'] {
${declarations('esoteric')}
}
`;

if (process.argv.includes('--check')) {
  const current = readFileSync(outputPath, 'utf8');
  if (current !== css) {
    console.error(
      'colors.generated.css is out of date: run `pnpm --filter @kb-chat/web tokens`.',
    );
    process.exit(1);
  }
} else {
  writeFileSync(outputPath, css);
}
