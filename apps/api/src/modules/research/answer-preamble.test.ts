import { describe, expect, it } from 'vitest';
import { preambleLength } from './answer-preamble.js';

const answerOf = (text: string): string => text.slice(preambleLength(text));

describe('preambleLength', () => {
  it.each([
    [
      'Agora tenho uma imagem completa. Os cinco princípios ocultos são…',
      'Os cinco princípios ocultos são…',
    ],
    [
      'Tenho tudo o que preciso. Vou compor a resposta.\n\n## Os princípios',
      '## Os princípios',
    ],
    [
      'Ótimo! Agora tenho todas as informações necessárias:\n\n- Ritmo [1]',
      '- Ritmo [1]',
    ],
    [
      'Perfeito, reuni as informações do acervo.\n---\nO Caibalion [2] diz…',
      'O Caibalion [2] diz…',
    ],
    ['Vou organizar o que encontrei:\n\nPrimeiro…', 'Primeiro…'],
    ['---\n\n## Resposta', '## Resposta'],
    ['\n\nEncontrei tudo o que precisava.\n\nTexto.', 'Texto.'],
  ])('drops the process talk at the start of %j', (text, answer) => {
    expect(answerOf(text)).toBe(answer);
  });

  it.each([
    'Os cinco princípios ocultos são: descontinuidade, limite, movimento [1].',
    'Encontrei no acervo cinco princípios: o mentalismo e a correspondência [1].',
    'O texto [2] diz que "tenho tudo" é uma ilusão do ego.',
    'Segundo o Caibalion [1], tudo é mente.',
    'Vou além do acervo (fora do acervo): a tradição…',
  ])('keeps an answer that starts with content: %j', (text) => {
    expect(answerOf(text)).toBe(text);
  });

  it('looks only at the very start of the answer', () => {
    const text =
      'Os princípios são sete [1].\n\nAgora tenho uma imagem completa.\n\n---\n';
    expect(answerOf(text)).toBe(text);
  });

  it('leaves an answer made only of preamble empty', () => {
    expect(answerOf('Tenho tudo o que preciso.')).toBe('');
  });
});
