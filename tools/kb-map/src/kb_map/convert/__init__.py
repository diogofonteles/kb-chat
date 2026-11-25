"""From a source to `raw/` (KBC-148): structured conversion, kept originals and provenance.

A file or a link becomes Markdown with the structure of the original (chapters, headings,
tables, pages), the original is kept untouched in `<topic>/raw/_originals/<sha256>.<ext>`, and
the Markdown's frontmatter says where it came from (`original_sha256`, `original_name`,
`converter`, `converter_version`, `converted_at`, `source_path`).

- `sources`     what a given file or URL is, and which converter takes it
- `converters`  Docling (PDF, images), MarkItDown (Office, EPUB, HTML), Firecrawl/Jina (links),
                CSV/JSON as they are, plain text; every one behind one small protocol
- `originals`   the store of originals, write-once
- `provenance`  frontmatter keys set line by line, every other key kept byte for byte
- `quality`     the useful characters of a text (BR-3: a conversion below 80 % replaces nothing)
- `ingest`      `kb ingest file`, behind a port (tests use a fake kb)
- `pipeline`    convert one source, reconvert one document
"""
