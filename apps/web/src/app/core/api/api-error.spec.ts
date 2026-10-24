import { API_ERROR_CODES } from '@kb-chat/contracts';
import { HttpErrorResponse } from '@angular/common/http';
import { errorMessage, toUiErrorCode } from './api-error.js';

describe('toUiErrorCode', () => {
  it('reads the contract envelope', () => {
    const err = new HttpErrorResponse({
      status: 503,
      error: { error: { code: 'SEARCH_UNAVAILABLE', message: 'x' } },
    });
    expect(toUiErrorCode(err)).toBe('SEARCH_UNAVAILABLE');
  });

  it('treats network and gateway failures as offline', () => {
    expect(toUiErrorCode(new HttpErrorResponse({ status: 0 }))).toBe('OFFLINE');
    expect(toUiErrorCode(new HttpErrorResponse({ status: 504 }))).toBe(
      'OFFLINE',
    );
  });

  it('falls back to INTERNAL for unknown bodies and non-HTTP errors', () => {
    expect(
      toUiErrorCode(new HttpErrorResponse({ status: 500, error: 'boom' })),
    ).toBe('INTERNAL');
    expect(toUiErrorCode(new Error('x'))).toBe('INTERNAL');
  });

  it('has a non-empty message for every code', () => {
    for (const code of [...API_ERROR_CODES, 'OFFLINE'] as const)
      expect(errorMessage(code).length).toBeGreaterThan(10);
  });

  it('has a plain pt-BR message for the common codes', () => {
    expect(errorMessage('OFFLINE')).toMatch(/servidor de busca/);
    expect(errorMessage('DOCUMENT_NOT_FOUND')).toMatch(/quarentena/);
  });
});
