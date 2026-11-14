export const REPLACEMENTS: readonly { before: string; after: string }[];
export function patchStore(source: string): { text: string; changed: boolean };
export function patchPackage(dir: string): { file: string; changed: boolean };
