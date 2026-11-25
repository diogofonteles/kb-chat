/**
 * How a kept original (KBC-148) is named on disk and served. The extension mirrors kb-map's
 * `stored_extension` (tools/kb-map/src/kb_map/convert/originals.py): lower case, letters and
 * digits only, at most 10, `md` kept as `markdown`, none as `bin`.
 */

const SAFE = /[^a-z0-9]/g;

export function originalExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  const raw = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
  const ext = raw.replace(SAFE, '').slice(0, 10) || 'bin';
  return ext === 'md' ? 'markdown' : ext;
}

/** What the browser may show in place: never HTML or SVG (they would run on our origin). */
const INLINE: Readonly<Record<string, string>> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  json: 'text/plain; charset=utf-8',
  markdown: 'text/plain; charset=utf-8',
};

export interface OriginalServing {
  readonly mime: string;
  /** Shown in the browser, or downloaded (`attachment`). */
  readonly inline: boolean;
}

export function servingOf(extension: string): OriginalServing {
  const mime = INLINE[extension];
  return mime
    ? { mime, inline: true }
    : { mime: 'application/octet-stream', inline: false };
}

/** `Content-Disposition` with the original's own name, safe for any character in it. */
export function dispositionOf(name: string, inline: boolean): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const kind = inline ? 'inline' : 'attachment';
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}
