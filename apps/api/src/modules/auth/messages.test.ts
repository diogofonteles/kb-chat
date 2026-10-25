import { describe, expect, it } from 'vitest';
import {
  alreadyHasAccess,
  approved,
  codeEmail,
  codeSms,
  newRequestForMasters,
  requestCooldown,
  requestPending,
} from './messages.js';

const origin = 'https://nova-alexandria.duckdns.org';
const SIGNATURE = '\n\n— Nova Alexandria';

describe('messages (KBC-016: the product is "Nova Alexandria", a feminine noun)', () => {
  it('names the product in every email subject with the right agreement', () => {
    expect(
      [
        codeEmail('signup', '123456'),
        codeEmail('login', '123456'),
        alreadyHasAccess(origin),
        requestPending(),
        requestCooldown('2026-10-25T15:00:00.000Z'),
        approved('Ana', origin),
      ].map((message) => message.subject),
    ).toEqual([
      'Confirme seu e-mail na Nova Alexandria',
      'Seu código de acesso à Nova Alexandria',
      'Você já tem acesso à Nova Alexandria',
      'Sua solicitação de acesso à Nova Alexandria está em análise',
      'Sua solicitação de acesso à Nova Alexandria',
      'Seu acesso à Nova Alexandria foi aprovado',
    ]);
  });

  it('signs every email body as Nova Alexandria and never says kb-chat', () => {
    const bodies = [
      codeEmail('signup', '123456'),
      codeEmail('login', '123456'),
      alreadyHasAccess(origin),
      requestPending(),
      requestCooldown('2026-10-25T15:00:00.000Z'),
      newRequestForMasters(
        {
          firstName: 'Ana',
          lastName: 'Lima',
          email: 'ana@example.com',
          phone: null,
          source: 'form',
        },
        origin,
      ),
      approved('Ana', origin),
    ].map((message) => message.text);

    for (const body of bodies) {
      expect(body.endsWith(SIGNATURE)).toBe(true);
      expect(body).not.toMatch(/kb-chat/i);
    }
    expect(bodies[1]).toContain(
      'Use este código para entrar na Nova Alexandria: 123456',
    );
    expect(bodies[5]).toMatch(/^Alguém pediu acesso à Nova Alexandria:/);
    expect(bodies[6]).toContain(
      'Olá, Ana! Seu acesso à Nova Alexandria foi aprovado.',
    );
  });

  it('starts the SMS with the product name', () => {
    expect(codeSms('123456')).toBe(
      'Nova Alexandria: seu código de acesso é 123456. Vale por 10 minutos.',
    );
  });
});
