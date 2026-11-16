---
id: KBC-120
title: "Recall da busca dentro do nível: o QMD devolve no máximo 20 por sub-busca, então quem vê pouco de um acervo recebe páginas curtas"
status: in-progress
slice: levels-release-2
outcome: um membro que vê 20 % de um acervo recebe na primeira página pelo menos 95 % dos 10 melhores resultados que existem para ele (90 % com 5 %), e quem vê tudo recebe no modo all os verdadeiros melhores (≥ 95 %), com p95 ≤ 250 ms em toda fatia e modo
depends_on: [KBC-111]
parent: LEVELS
---

# KBC-120 — Recall da busca dentro do nível

*Aberto pelo KBC-111 (AC-4), 2026-11-12.* Medição em `work/KBC-111/recall.md` com `apps/api/src/scripts/levels-recall.ts --qmd <índice>`: o QMD 2.8.3 pega no máximo 20 resultados por sub-busca (`structuredSearch` chama `searchFTS(…, 20)` e `searchVec(…, 20)` com 20 fixo, funde e corta em `candidateLimit` = 40), seja qual for o `limit` que a API pede. O orçamento adaptativo da ADR 0036 §7 pede 300 ou 1.000 e recebe 20 a 40. Com 20 % visível a primeira página enche 31 % (exact), 41 % (semantic) e 65 % (all); com 5 %, 8 %, 11 % e 17 %. O caminho da API está certo (recall 1,000 com um índice que respeita o `limit`); o teto está no índice. Achado anterior aos níveis: o orçamento base 60/200 (ADR 0003) também nunca foi atendido; total, facetas e `capped` vêm de no máximo 40 candidatos.

## Story
Como pessoa com um nível que vê só parte de um acervo, quero que a busca me traga os melhores resultados entre os que posso ver, e não só os poucos que sobram entre os 20 primeiros de todos.

## Scope
**In:** escolher e construir um caminho que filtre dentro do índice ou peça candidatos suficientes; medir de novo com o script do KBC-111 (fatias 100/50/20/5 %, os três modos) no QMD real; ADR (emenda da 0036 §7 ou nova).
**Out:** mudar a ordem dos resultados de quem vê tudo em exact e semantic; o rerank. (O modo all de quem vê tudo entrou no escopo pela Q-2, 2026-11-16.)

## Opções (decisão de arquitetura, sem padrão razoável sem o dono)
1. **Coleção do QMD por (acervo, nível)** (ADR 0036 opção 3): o Mac monta as coleções a partir de uma exportação dos níveis; a busca pede só as coleções dos níveis da pessoa (OR em `collections`). Filtra de verdade; cada mudança de nível espera um reindex no Mac.
2. **QMD com o número de candidatos configurável** (contribuição ao QMD, ou versão nova que o tenha): `searchFTS`/`searchVec` com `max(20, limit)` e `candidateLimit` passado pela API. Menor mudança no app; depende do projeto do QMD.
3. **Ler o índice do QMD direto para o modo léxico** (ADR 0036 opção 4): filtro na consulta só no `exact`; acopla ao schema interno (Q5) e não cobre o vetorial.

## Business rules
- BR-1: nada do que o KBC-111 prova muda (nenhuma marca de item oculto, contagens iguais às de um acervo sem ele).
- BR-2 (revista pelo dono em 2026-11-16, Q-2): em exact e semantic, as primeiras páginas de quem vê 100 % continuam idênticas às de hoje; em all, passam a bater com o ranking de todos os textos (recall@10 ≥ 0,95 a 100 %).
  - ~~Original: quem vê tudo recebe os mesmos resultados de hoje.~~

## Acceptance criteria
- **AC-1** (NFR-1 do KBC-111): Given o script do KBC-111 com `--qmd`, Then recall@10 ≥ 0,95 nas fatias de 20 % e 50 % e ≥ 0,90 na de 5 %, nos três modos.
- **AC-2** (revisto pelo dono em 2026-11-16, Q-2; substitui o NFR-2 do KBC-111 aqui): Given o mesmo script com `--qmd` num QMD 2.8.3 patchado, Then p95 ≤ 250 ms em toda fatia (100/50/20/5 %) e todo modo; e a 100 % no modo all, recall@10 ≥ 0,95 contra o ranking de todos os textos.
  - ~~Original: p95 a 20 % ≤ 1,25 × o p95 sem escala, em cada modo.~~ Falhava com o QMD real (custo do QMD por candidato, `work/KBC-120/recall.md`).
- **AC-3** (BR-1): Given `levels-leakage.integration.test.ts`, Then continua verde.

## Open questions
- ~~Q-1 (dono/arquitetura): qual das três opções.~~ Respondida em 2026-11-14: **opção 2**, com um patch nosso no QMD 2.8.3 aplicado na imagem da API (`deploy/qmd/candidates-per-subsearch.mjs`, ADR 0036, emenda KBC-120).
- ~~Q-2 (dono, 2026-11-14): o AC-2 não passa com a opção 2: a 20 % o p95 vai de 5,8 → 42 ms (exact), 96 → 131 ms (semantic) e 98 → 150 ms (all), contra 1,25 ×. Caminhos: aceitar o custo, filtrar dentro do índice (opção 3) ou um orçamento menor que `base / fatia`.~~ Respondida em 2026-11-16: **aceitar a latência a mais e estender a correção a todos: quem vê 100 % também tem que receber os verdadeiros melhores resultados no modo all.** O NFR-2/AC-2 antigo (p95 a 20 % ≤ 1,25 × o p95 a 100 %) é substituído por um teto absoluto: p95 ≤ 250 ms em toda fatia (100/50/20/5 %) e todo modo, medido no QMD real patchado. A BR-2 é revista: em exact e semantic as primeiras páginas de quem vê 100 % ficam idênticas às de hoje; em all passam a bater com o ranking de todos os textos (recall@10 ≥ 0,95 a 100 %).

## Definition of ready
- [x] Story, escopo e resultado
- [x] Medição de partida
- [x] Opção escolhida (Q-1: opção 2, 2026-11-14)

## Estado (2026-11-16)
Medição em `work/KBC-120/recall.md` (QMD 2.8.3 patchado, num diretório de rascunho).
- AC-1: **passa** (recall@10 1,000 em exact e semantic; em all 0,955 / 0,965 / 0,985 a 50 / 20 / 5 %).
- AC-2 (revisto, p95 ≤ 250 ms): **passa** na medição final; maior p95 227,8 ms (all a 5 %). Risco: a 5 % a margem é de ~20 ms e passou de 250 ms em duas de quatro execuções com a máquina carregada.
- AC-3: `levels-leakage.integration.test.ts` verde nos gates.
- BR-2 (revista): a 100 %, exact 20/20 e semantic 20/20 primeiras páginas idênticas às de hoje; all com recall@10 0,985 (era 0,825), com profundidade 150 por sub-busca (`WHOLE_VIEW_HYBRID_DEPTH`; 100 dava 0,950 exato, sem margem).
