---
id: KBC-120
title: "Recall da busca dentro do nível: o QMD devolve no máximo 20 por sub-busca, então quem vê pouco de um acervo recebe páginas curtas"
status: draft
slice: levels-release-2
outcome: um membro que vê 20 % de um acervo recebe na primeira página pelo menos 95 % dos 10 melhores resultados que existem para ele (90 % com 5 %), sem passar de 1,25 × o p95 de hoje
depends_on: [KBC-111]
parent: LEVELS
---

# KBC-120 — Recall da busca dentro do nível

*Aberto pelo KBC-111 (AC-4), 2026-11-12.* Medição em `work/KBC-111/recall.md` com `apps/api/src/scripts/levels-recall.ts --qmd <índice>`: o QMD 2.8.3 pega no máximo 20 resultados por sub-busca (`structuredSearch` chama `searchFTS(…, 20)` e `searchVec(…, 20)` com 20 fixo, funde e corta em `candidateLimit` = 40), seja qual for o `limit` que a API pede. O orçamento adaptativo da ADR 0036 §7 pede 300 ou 1.000 e recebe 20 a 40. Com 20 % visível a primeira página enche 31 % (exact), 41 % (semantic) e 65 % (all); com 5 %, 8 %, 11 % e 17 %. O caminho da API está certo (recall 1,000 com um índice que respeita o `limit`); o teto está no índice. Achado anterior aos níveis: o orçamento base 60/200 (ADR 0003) também nunca foi atendido; total, facetas e `capped` vêm de no máximo 40 candidatos.

## Story
Como pessoa com um nível que vê só parte de um acervo, quero que a busca me traga os melhores resultados entre os que posso ver, e não só os poucos que sobram entre os 20 primeiros de todos.

## Scope
**In:** escolher e construir um caminho que filtre dentro do índice ou peça candidatos suficientes; medir de novo com o script do KBC-111 (fatias 100/50/20/5 %, os três modos) no QMD real; ADR (emenda da 0036 §7 ou nova).
**Out:** mudar a ordem dos resultados de quem vê tudo; o rerank.

## Opções (decisão de arquitetura, sem padrão razoável sem o dono)
1. **Coleção do QMD por (acervo, nível)** (ADR 0036 opção 3): o Mac monta as coleções a partir de uma exportação dos níveis; a busca pede só as coleções dos níveis da pessoa (OR em `collections`). Filtra de verdade; cada mudança de nível espera um reindex no Mac.
2. **QMD com o número de candidatos configurável** (contribuição ao QMD, ou versão nova que o tenha): `searchFTS`/`searchVec` com `max(20, limit)` e `candidateLimit` passado pela API. Menor mudança no app; depende do projeto do QMD.
3. **Ler o índice do QMD direto para o modo léxico** (ADR 0036 opção 4): filtro na consulta só no `exact`; acopla ao schema interno (Q5) e não cobre o vetorial.

## Business rules
- BR-1: nada do que o KBC-111 prova muda (nenhuma marca de item oculto, contagens iguais às de um acervo sem ele).
- BR-2: quem vê tudo recebe os mesmos resultados de hoje.

## Acceptance criteria
- **AC-1** (NFR-1 do KBC-111): Given o script do KBC-111 com `--qmd`, Then recall@10 ≥ 0,95 nas fatias de 20 % e 50 % e ≥ 0,90 na de 5 %, nos três modos.
- **AC-2** (NFR-2 do KBC-111): Then p95 a 20 % ≤ 1,25 × o p95 sem escala, em cada modo.
- **AC-3** (BR-1): Given `levels-leakage.integration.test.ts`, Then continua verde.

## Open questions
- Q-1 (dono/arquitetura): qual das três opções.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Medição de partida
- [ ] Opção escolhida (Q-1)
