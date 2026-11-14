import { API_ERROR_CODES } from '@kb-chat/contracts';
import { HttpErrorResponse } from '@angular/common/http';
import {
  errorMessage,
  listenToInternalErrors,
  toUiErrorCode,
} from './api-error.js';

describe('toUiErrorCode', () => {
  it('tells its listener of a failure read as INTERNAL, and only of those (KBC-123 AC-4)', () => {
    const heard = vi.fn();
    const stop = listenToInternalErrors(heard);
    const outside = new Error('reply outside the contract');
    toUiErrorCode(outside);
    toUiErrorCode(new HttpErrorResponse({ status: 500, error: 'not json' }));
    toUiErrorCode(new HttpErrorResponse({ status: 0 }));
    toUiErrorCode(
      new HttpErrorResponse({
        status: 403,
        error: { error: { code: 'FORBIDDEN', message: 'x' } },
      }),
    );
    expect(heard).toHaveBeenCalledTimes(2);
    expect(heard).toHaveBeenCalledWith(outside);
    // A stale stop never removes a newer listener.
    const newer = vi.fn();
    listenToInternalErrors(newer);
    stop();
    toUiErrorCode(new Error('x'));
    expect(newer).toHaveBeenCalledTimes(1);
    listenToInternalErrors(heard)();
    toUiErrorCode(new Error('y'));
    expect(heard).toHaveBeenCalledTimes(2);
  });

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

  it('unwraps errors wrapped by rxResource and reads text bodies', () => {
    const http = new HttpErrorResponse({
      status: 409,
      error: '{"error":{"code":"LLM_NOT_CONFIGURED","message":"x"}}',
    });
    expect(toUiErrorCode(new Error('wrapped', { cause: http }))).toBe(
      'LLM_NOT_CONFIGURED',
    );
    expect(
      toUiErrorCode(new HttpErrorResponse({ status: 500, error: 'not json' })),
    ).toBe('INTERNAL');
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
