---
id: KBC-148
title: "Da fonte ao raw: conversão estruturada (Docling, MarkItDown, Firecrawl), originais guardados e proveniência, com a reconversão do acervo"
status: ready
slice: complete-answers
outcome: todo documento do acervo vira Markdown com títulos, capítulos, tabelas e páginas; o original fica guardado e rastreável; as seções do mapa nascem dos títulos
depends_on: []
---

# KBC-148 — Conversão estruturada, originais e proveniência

## Story
Como dono, quero que cada livro, apostila ou página que entra no acervo vire um texto com a estrutura do original (capítulos, títulos, tabelas, páginas) e que o original fique guardado, para a IA citar o trecho certo e qualquer pessoa conferir na fonte.

## Scope
**In:**
- a etapa `kb-map convert` no Mac, antes do `kb ingest`:
  - **Docling** para PDF (com texto ou escaneado, com OCR e tabelas);
  - **MarkItDown** para Office, EPUB e HTML;
  - **Firecrawl** (Jina Reader como alternativa) para links;
  - **sem conversão** para CSV e JSON, com uma página que descreve o arquivo;
  - para imagens, o OCR e uma descrição marcada como "descrição gerada";
- o original em `raw/_originals/<sha256>.<ext>`;
- a proveniência no frontmatter: `original_sha256`, `original_name`, `converter` e a versão, `converted_at` e `source_path`;
- os nomes `<autor ou origem>-<título>-<ano>`;
- a **reconversão do acervo atual** a partir dos originais que ainda existem (pastas de origem do Dropbox e `_extract`). Ela troca o texto puro pelo Markdown estruturado e mantém o id do documento, as chaves do kb e a autoria;
- o "Ver original" no documento do app.

**Out:** áudio e vídeo (continuam no transcritor); o envio pelo app (KBC-149).

## Business rules
- BR-1: o original nunca é alterado nem apagado; o Markdown é um derivado e aponta para ele pelo hash.
- BR-2: a reconversão não muda o id do documento nem as chaves que o kb ou o dono escreveram (`author_group`, `author`, relações). Só o corpo e a proveniência mudam, e o kb reclassifica o que mudou.
- BR-3: uma conversão vazia, ilegível ou muito menor que o texto atual (abaixo de 80 % dos caracteres úteis) não substitui nada e vai para a fila de revisão.
- BR-4: o texto descrito por um modelo (imagem) é marcado e nunca se passa pelo texto do autor nas citações.

## Functional requirements
- FR-1: `kb-map convert <topic> <file|url>...` deve converter, guardar o original, gravar o Markdown com a proveniência e entregar ao `kb ingest`. (BR-1, BR-4)
- FR-2: `kb-map reconvert <topic> [--from <dir>]` deve achar o original de cada documento pelo `source_path` e pelo nome, converter, comparar (BR-3) e trocar o corpo, num lote retomável. (BR-2, BR-3)
- FR-3: o documento do app deve mostrar "Ver original" quando houver original, servido pela API com o mesmo controle de nível do documento.

## Non-functional requirements
- NFR-1: a reconversão do Hermetismo (cerca de 1.200 PDFs e textos com original) termina em ≤ 8 h no Mac, sem custo de API, exceto as descrições de imagem (≤ US$ 3).

## Acceptance criteria
- AC-1 (FR-1, BR-1): Given um PDF de fixture com 3 capítulos e uma tabela, When convertido, Then o Markdown tem os 3 títulos e a tabela, e o original está em `_originals/` com o hash no frontmatter.
- AC-2 (FR-2, BR-2): Given um documento já classificado, com `author_group`, When reconvertido, Then o id, `author_group` e as relações continuam, e o corpo ganha os títulos.
- AC-3 (BR-3, negativo): Given um PDF cujo OCR sai com 30 % do texto atual, When reconvertido, Then nada muda e o caso vai para a revisão.
- AC-4 (BR-4): Given uma imagem de diagrama, When convertida, Then a descrição está marcada como gerada e não aparece como fala do autor numa citação.
- AC-5 (FR-3, permissão): Given um documento de nível alto, When Ana (nível baixo) pede o original pela URL, Then recebe 404.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1–AC-4 | unitário/integração (pytest) | Fixtures pequenas de PDF, DOCX e imagem |
| AC-5 | integração (API) | Suíte de níveis |
| Reconversão real | manual (registrado) | Mac do dono, relatório em `docs/research/` |

## References
`docs/research/2026-11-16-source-to-raw.md` · `docs/research/2026-11-16-complete-answers-deep.md` · ADR 0003 (catálogo pelo frontmatter), 0035 · KBC-139 (as seções usam os títulos)

## Decisões assumidas (o dono pode mudar)
- Docling e MarkItDown rodam localmente (livres). A descrição de imagem usa o modelo barato já aprovado.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
