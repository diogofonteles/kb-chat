import { describe, expect, it } from 'vitest';
import { countPromptTokens } from './whisper-tokens.js';

/** The list migration 5 seeds. */
const PILOT = [
  'Mestre Gabriel',
  'UDV',
  'União do Vegetal',
  'Vegetal',
  'Hoasca',
  'Burracheira',
  'Caiano',
  'Minguarana',
  'Lupunamanta',
  'Supairunam',
  'Perambulando',
  'Caminho Firme',
  'Jardim das Flores',
  'Luz do Universo',
  'Conselheira do Rei',
  'Mestre Florêncio',
  'Mestre Paixão',
  'Mestre Bartolomeu',
  'Mestre Monteiro',
  'Mestre José Luiz',
  'Mestre Nonato',
  'Mestre Modesto',
  'chamada',
  'sessão',
  'estatutos',
  'Tiuaco',
  'Mariri',
  'Chacrona',
  'Rei Zinca',
  'Rei Salomão',
  'Associação Beneficente União do Vegetal',
  'diretoria',
];

// Expected counts come from mlx_whisper's own tokenizer, encoding what the worker's
// `build_prompt` sends: get_tokenizer(True, num_languages=100, language="pt").
describe('countPromptTokens (KBC-040 BR-2)', () => {
  it.each([
    ['the pilot list', PILOT, 162],
    ['one term', ['Tiuaco'], 4],
    [
      'accents, digits, symbols and other scripts',
      ["São João d'Aliança", 'R$ 1.000', 'ação—reação', '日本語', 'Çá é 123a'],
      30,
    ],
    ['contractions', ["it's", "we'll go"], 7],
  ])('counts %s as the transcriber does', (_name, terms, tokens) => {
    expect(countPromptTokens(terms)).toBe(tokens);
  });
});
