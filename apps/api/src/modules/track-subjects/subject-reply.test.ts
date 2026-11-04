import { describe, expect, it } from 'vitest';
import { parseSubjectReply } from './subject-reply.js';

const JSON_REPLY = '{"faixas":[{"faixa":1,"assuntos":["Cabala"]}]}';

describe('parseSubjectReply', () => {
  it.each([
    ['bare', JSON_REPLY],
    ['fenced', `\`\`\`json\n${JSON_REPLY}\n\`\`\``],
    ['after reasoning', `<think>talvez {isso}</think>${JSON_REPLY}`],
    ['with text around', `Aqui está: ${JSON_REPLY} Pronto.`],
  ])('reads an answer %s', (_, answer) => {
    expect(parseSubjectReply(answer)).toMatchObject([{ faixa: 1 }]);
  });

  it.each(['isto não é json', '{"faixas":', '{"outra":1}'])(
    'gives null for what it cannot read: %s',
    (answer) => {
      expect(parseSubjectReply(answer)).toBeNull();
    },
  );
});
