export function nodeProblem(input: {
  version: string;
  compileOptions: readonly string[] | null;
  wanted: string;
}): string | null;
export function sqliteCompileOptions(): string[] | null;
export function checkNode(): string | null;
export function requireFittingNode(): void;
