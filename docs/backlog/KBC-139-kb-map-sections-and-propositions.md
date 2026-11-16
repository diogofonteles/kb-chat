---
id: KBC-139
title: "Mapa do acervo (1): cada documento em seções com os ensinamentos, o contexto e o autor"
status: ready
slice: complete-answers
outcome: cada ensinamento de um livro ou palestra fica endereçável (seção, posição e autor), e não só o documento inteiro
depends_on: [KBC-138]
---

# KBC-139 — Seções com proposições e contexto

## Story
Como estudante, quando pergunto sobre um assunto tratado num capítulo de um livro longo, quero que a pesquisa ache esse capítulo, para não perder o que está dentro de documentos grandes.

## Scope
**In:**
- a ferramenta `tools/kb-map` (Python com uv, no Mac);
- a divisão em seções de cada documento, respeitando títulos e capítulos;
- por seção: uma linha de contexto, as proposições (os ensinamentos afirmados), as entidades, o autor da afirmação (Mestre Laércio ou outro, ADR 0015) e a posição no corpo (a mesma contagem do `read_document`);
- a gravação em `<topic>/map/sections/<doc>.json`, ao lado do vault, sem mudar o documento;
- o provedor plugável: o CLI do Claude ou do Codex (assinatura) ou o modelo do kb (OpenRouter).

**Out:** a árvore (KBC-140); o dossiê (KBC-141); rodar no acervo inteiro (KBC-143).

## Business rules
- BR-1: as seções cobrem o corpo inteiro, sem buracos nem sobreposição. Trechos sem ensinamento (sumário, índice, ficha catalográfica) viram seção marcada `fora-do-mapa` com o motivo.
- BR-2: uma proposição só afirma o que a seção diz, com as palavras do acervo quando possível. Nada de conhecimento de fora.
- BR-3: o resultado é incremental: um documento cujo conteúdo (hash) não mudou não é reprocessado.
- BR-4: a API nunca escreve o mapa. Só o Mac escreve (Q7).

## Functional requirements
- FR-1: `kb-map sections <topic> [--doc <path>] [--provider claude|codex|openrouter]` deve gravar as seções de cada documento com o hash do corpo e a versão do extrator. (BR-1, BR-3)
- FR-2: cada seção deve ter `start`, `end`, `context`, `propositions[]`, `entities[]`, `speaker` e `status` (`ok`, `fora-do-mapa`). (BR-1, BR-2)
- FR-3: a extração deve validar o que o modelo devolve (posições dentro do corpo, cobertura contínua) e repetir uma vez. Se falhar de novo, o documento vai para a fila de revisão. (BR-1)

## Non-functional requirements
- NFR-1: um livro de 255 KB é processado em ≤ 5 min na assinatura, e o progresso é gravado por documento (retomável).

## Acceptance criteria
- AC-1 (FR-1, FR-2, BR-1): Given um documento de fixture com 3 capítulos e um sumário, When as seções são extraídas, Then saem as seções dos capítulos com proposições e a do sumário marcada `fora-do-mapa`, cobrindo do primeiro ao último caractere.
- AC-2 (BR-3): Given um documento já processado e não alterado, When o comando roda de novo, Then nenhuma chamada ao modelo é feita.
- AC-3 (FR-3, negativo): Given um modelo que devolve posições fora do corpo, When a validação roda, Then repete uma vez e depois manda o documento para a revisão, sem gravar seções inválidas.
- AC-4 (FR-2, ADR 0015): Given uma palestra do Mestre Laércio que cita outro autor, When extraída, Then as proposições citadas levam o `speaker` do autor citado.
- AC-5 (piloto): Given 50 documentos reais, When processados na assinatura, Then o tempo e a cota usados ficam registrados no relatório do piloto.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1–AC-4 | unitário (pytest) | Provedor fake com respostas gravadas |
| AC-5 | manual (registrado) | Vault real, Mac do dono |

## References
`docs/research/2026-11-16-complete-answers-deep.md` §3 e §5 · ADR 0003, 0015, 0035 · `tools/transcriber` (modelo de ferramenta)

## Decisões assumidas (o dono pode mudar)
- O mapa vive em `<topic>/map/`, ao lado do vault, e vai para a produção pelo `sync-vault.sh`. Uma ADR nova registra isso.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
