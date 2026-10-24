#!/usr/bin/env node
// Fake `kb`: echoes its arguments inside a single kb search JSON hit.
const args = process.argv.slice(2);
if (args.includes('fail')) process.exit(2);
const collection = args[args.indexOf('--collection') + 1];
process.stdout.write(
  JSON.stringify([
    {
      path: `qmd://${collection}/raw/articles/a-lei-do-ritmo.md`,
      score: 0.8,
      preview: args.join(' '),
    },
  ]),
);
