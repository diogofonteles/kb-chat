// Shared by the fake CLIs (KBC-030): how a sweep's batch reader and its answer reply, and
// the plan an exhaustive turn hands in. A batch finds one thing in its first document; the
// answer cites the first finding and, like a careless model, adds a false coverage line.
import { appendFileSync } from 'node:fs';

export const SWEEP_PLAN = {
  target: { authorship: 'mestre-laercio' },
  phrases: ['ritmo'],
  extract: 'o que diz do ritmo',
};

/** The reply of a sweep call, or null when the prompt is a research turn. */
export function sweepReply(prompt) {
  if (prompt.includes('Você lê um lote de documentos')) {
    const title = /^\[D1\] ([^·\n]+)/m.exec(prompt)?.[1]?.trim();
    return title ? `- [D1] “${title}” trata do ritmo — “trecho”\n` : 'NENHUM';
  }
  if (prompt.includes('O aplicativo já varreu o conjunto inteiro')) {
    const found = /^- \[(\d+)\] “([^”]+)”/m.exec(prompt);
    const cited = found ? `“${found[2]}” trata do ritmo [${found[1]}]` : 'nada';
    return `Segundo o acervo, ${cited}.\n\n**Cobertura:** varri 9.999 documentos de 9.999.\n`;
  }
  return null;
}

/** Appends one line per run to the `log` file of fake-cli.json: what the CLI was given. */
export function logRun(fake, entry) {
  if (fake.log) appendFileSync(fake.log, `${JSON.stringify(entry)}\n`);
}
