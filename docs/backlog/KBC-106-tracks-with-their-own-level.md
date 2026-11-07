---
id: KBC-106
title: "Faixas com nível próprio: escolher o nível na validação e na edição da faixa, e documentos de faixa (ADR 0035) e \"Veja também\" respeitando o nível"
status: ready
slice: levels-release-2
outcome: uma pergunta e resposta sensível dentro de uma palestra aberta pode ficar num nível mais alto, sem esconder a palestra inteira
depends_on: [KBC-105]
parent: LEVELS
---

# KBC-106 — Faixas com nível próprio

## Story
Como quem edita uma gravação, quero dar a uma faixa um nível diferente do da gravação, para restringir só o trecho que precisa.

## Scope
**In:** **Nível** por faixa no passo de validação (KBC-066) e na edição da faixa aprovada (KBC-073), padrão "o da gravação"; a faixa com nível próprio deixa de seguir a gravação (KBC-105 BR-7) até "Voltar ao nível da gravação"; a gravação completa com uma faixa acima do nível da pessoa: a pessoa ouve a gravação, mas o trecho dessa faixa é pulado no player, some da transcrição e da legenda e não é achado em "Na fala"; documentos de faixa (ADR 0035 §5) e faixas no "Veja também" (KBC-070, KBC-101) passam pela regra de nível.
**Out:** níveis diferentes por trecho sem faixa.

## Business rules
- BR-1: a faixa tem o nível da gravação até alguém escolher outro; nunca abaixo do nível da gravação (o trecho está na gravação inteira). Subir a gravação acima do nível próprio de uma faixa sobe a faixa junto, e a confirmação diz quantas faixas sobem.
- BR-2: quem vê a gravação e não vê uma faixa dela não recebe o áudio, o texto, a legenda nem as palavras do intervalo da faixa.
- BR-3: um documento de faixa no vault é visível só se a faixa for visível pela regra de nível, além das checagens da ADR 0035 §5.
- BR-4: mudar o nível da faixa é auditado e muda na hora em todas as superfícies.

## Functional requirements
- FR-1: `trackPatchSchema` e o rascunho de faixas aceitam `level`; `level` abaixo do da gravação → 400 `LEVEL_BELOW_RECORDING`. (BR-1)
- FR-2: o stream da gravação, para quem não vê uma faixa, serve uma lista de intervalos ocultos (`hidden: [{ startMs, endMs }]`) e o servidor recusa `Range` dentro deles (416); transcrição, palavras, legenda e "Na fala" omitem os segmentos desses intervalos. (BR-2)
- FR-3: a checagem de visibilidade de entradas com `media` (ADR 0035 §5) usa o nível da faixa. (BR-3)
- FR-4: escrita auditada. (BR-4)
- FR-5: a web mostra **Nível** na linha da faixa (T20 passos 3 e 4, edição) e o player pula os intervalos ocultos com o aviso "Trecho restrito" na barra.

## Non-functional requirements
- NFR-1: o pulo de um intervalo oculto acontece em ≤ 250 ms de reprodução (E2E com áudio real gerado por ffmpeg, Chrome e WebKit).

## Acceptance criteria
- **AC-1** (BR-1): Given uma gravação QS com 3 faixas, When o editor põe a faixa 2 em CDC, Then só ela fica em CDC; tentando QS numa gravação CI, 400.
- **AC-2** (BR-2): Given Ana (CI), When ouve a gravação, Then o player pula a faixa 2 com "Trecho restrito", a transcrição e a legenda não têm o texto dela, e "Na fala" não acha uma frase dela.
- **AC-3** (BR-2, negativo): Given Ana pede por `Range` um byte dentro do intervalo da faixa 2, Then 416.
- **AC-4** (BR-3): Given o documento da faixa 2 no vault (ADR 0035), When Ana pesquisa com IA, Then a faixa não aparece em ferramenta, fonte nem cobertura; no "Veja também" de um texto ligado, também não.
- **AC-5** (BR-4): Given a faixa volta ao nível da gravação, Then Ana a ouve de novo na próxima requisição e a auditoria tem as duas mudanças.
- **AC-6** (master): Given o master, Then ouve tudo e vê o selo CDC na faixa 2.
- **AC-7** (sem regressão): Given faixas sem nível próprio, Then os specs de faixas e de player passam sem mudança.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-3, AC-5 | integração | `track-levels.integration.test.ts` |
| AC-2, NFR-1 | E2E de mídia real | `e2e/specs/track-levels.spec.ts` no Chrome e WebKit, `--repeat-each=3` |
| AC-4 | integração | depende do KBC-099; se o KBC-099 ainda não existir, AC-4 passa para o KBC-099 como critério extra |
| AC-6, AC-7 | integração + existentes | — |

## References
ADR [0036](../adr/0036-access-levels-per-collection.md) §3, §7 · [0035](../adr/0035-tracks-as-kb-documents.md) §5 · [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) · Telas T15 e T20 com a emenda de 2026-11-06 · Barra de qualidade da fase 2.

## Open questions
Resolvidas em 2026-11-07 (dono, conversa: "aprovo todos"), com o padrão recomendado:
- Faixas herdam o nível da gravação e podem ter um nível mais alto.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR e tela
- [x] Depende do KBC-105
- [x] Cabe num goal
