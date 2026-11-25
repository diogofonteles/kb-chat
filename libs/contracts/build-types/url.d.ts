/**
 * The part of the WHATWG URL the contracts read, which browsers and Node both have. The build
 * takes no DOM and no Node types (the contracts run in both), so it is declared here; the
 * typecheck, which sees Node's through Vitest, does not include this file.
 */
declare class URL {
  static canParse(url: string): boolean;
  constructor(url: string);
  readonly protocol: string;
  readonly username: string;
  readonly password: string;
  readonly hostname: string;
  readonly host: string;
  readonly origin: string;
  readonly href: string;
  pathname: string;
  search: string;
  hash: string;
  readonly searchParams: {
    get(name: string): string | null;
    has(name: string): boolean;
    delete(name: string): void;
    toString(): string;
  };
  toString(): string;
}
