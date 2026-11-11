---
id: KBC-076
title: "Vídeo na Biblioteca: chip Áudio/Vídeo, selo \"Vídeo\" e grade com pôster"
status: ready
slice: later-video
outcome: quem estuda acha e retoma uma palestra em vídeo na Biblioteca como faz com os áudios
depends_on: [KBC-051, KBC-074]
---

# KBC-076 — Vídeo na Biblioteca: chip Áudio/Vídeo, selo "Vídeo" e grade com pôster

## Story
Como quem estuda pelas palestras, quero ver os vídeos na Biblioteca junto com os áudios, filtrar por tipo e retomar de onde parei.

Parte de vídeo tirada do KBC-051 (decisão do dono, 2026-11-03).

## Scope
**In:** vídeos nas seções da Biblioteca ("Continuar ouvindo", "Ouvidas recentemente", "Todas"); chip de filtro Áudio/Vídeo; selo "Vídeo" em texto além do ícone; pôster na visão em grade.
**Out:** offline de vídeo (KBC-077).

## Business rules
- BR-1: tudo o que vale para áudio na Biblioteca vale para vídeo; o tipo aparece em texto ("Vídeo"), nunca só pelo ícone.

## Functional requirements
- FR-1: A Biblioteca deve listar vídeos com o selo "Vídeo" e o pôster na grade. (BR-1)
- FR-2: O chip "Vídeo" deve filtrar e combinar com os outros chips, com a contagem.

## Non-functional requirements
- NFR-1: a Biblioteca abre no mesmo tempo do KBC-051 com vídeos misturados.

## Acceptance criteria
- **AC-1** (FR-1, BR-1): Given três mídias em andamento (uma de vídeo), When abre a Biblioteca, Then "Continuar ouvindo" mostra as três, a de vídeo com o selo "Vídeo" em texto.
- **AC-2** (FR-2): Given os chips "Vídeo" e "Em andamento", When marcados, Then só aparecem vídeos em andamento, e a contagem diz quantos.
- **AC-3** (acessibilidade): sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível |
|---|---|
| AC-1, AC-2 | integração + E2E (vídeo real gerado por ffmpeg) |
| AC-3 | E2E |

## References
KBC-051 (parte de áudio) · benchmark `docs/research/2026-10-29-media-library-benchmark.md`

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled; no open questions
- [x] Fits one goal
