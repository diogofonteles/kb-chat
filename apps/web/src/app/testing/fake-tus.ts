import type { UploadOptions } from 'tus-js-client';
import type { TusFactory, TusSession } from '@core/media/tus-upload.js';

/** One upload over the fake tus client: the test plays the server's part. */
export class FakeTusSession implements TusSession {
  started = false;
  aborted = false;

  constructor(
    readonly file: Blob,
    readonly options: UploadOptions,
  ) {}

  start(): void {
    this.started = true;
  }

  abort(): Promise<void> {
    this.aborted = true;
    return Promise.resolve();
  }

  progress(loaded: number, total = this.file.size): void {
    this.options.onProgress?.(loaded, total);
  }

  succeed(): void {
    this.options.onSuccess?.({ lastResponse: fakeResponse(204) });
  }

  /** Status 0: the connection, not an answer. */
  fail(status = 0, body = ''): void {
    const error = Object.assign(new Error('tus failed'), {
      originalRequest: null,
      originalResponse: status === 0 ? null : fakeResponse(status, body),
      causingError: null,
    });
    this.options.onError?.(
      error as Parameters<NonNullable<UploadOptions['onError']>>[0],
    );
  }
}

function fakeResponse(status: number, body = '') {
  return {
    getStatus: () => status,
    getHeader: () => undefined,
    getBody: () => body,
    getUnderlyingObject: () => null,
  };
}

/** Records every upload started, in order. */
export class FakeTus {
  readonly sessions: FakeTusSession[] = [];
  readonly factory: TusFactory = (file, options) => {
    const session = new FakeTusSession(file, options);
    this.sessions.push(session);
    return session;
  };

  /** The newest upload: the one a test usually plays. */
  get last(): FakeTusSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error('no upload started');
    return session;
  }
}
