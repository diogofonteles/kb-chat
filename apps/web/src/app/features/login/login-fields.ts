import { normalizePhone } from '@kb-chat/contracts';

/** Field checks of the login forms (screens.md T10), run on submit only (MA-22). */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^\d{6}$/;

export const emailError = (value: string): string =>
  EMAIL.test(value.trim())
    ? ''
    : $localize`:@@login.emailError:Digite um e-mail válido, como nome@exemplo.com.`;

export const phoneError = (value: string): string =>
  normalizePhone(value)
    ? ''
    : $localize`:@@login.phoneError:Digite o celular com DDD.`;

export const nameError = (value: string, which: 'first' | 'last'): string => {
  if (value.trim()) return '';
  return which === 'first'
    ? $localize`:@@login.firstNameError:Digite seu nome.`
    : $localize`:@@login.lastNameError:Digite seu sobrenome.`;
};

export const codeError = (value: string): string =>
  CODE.test(value.trim())
    ? ''
    : $localize`:@@login.codeError:O código tem 6 dígitos.`;

/** Only digits, at most six: what a one-time code field keeps of what is typed or pasted. */
export const digitsOf = (value: string): string =>
  value.replace(/\D/g, '').slice(0, 6);

/** "Muitos pedidos…" for the login forms; the shared copy talks about searches. */
export const sendFailure = (code: string, fallback: () => string): string =>
  code === 'RATE_LIMITED'
    ? $localize`:@@login.rateLimited:Muitos pedidos em pouco tempo. Espere um minuto e tente de novo.`
    : fallback();
