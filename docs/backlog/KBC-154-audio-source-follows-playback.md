---
id: KBC-154
title: "A fonte de áudio acompanha o que está sendo ouvido"
status: ready
slice: ui-v2-areas
outcome: enquanto a faixa toca, o painel da fonte de áudio mostra e destaca a fala que está sendo ouvida
depends_on: [KBC-150]
---

# KBC-154 — A fonte de áudio acompanha a reprodução

Relato do dono (2026-11-17, localhost, vault real, faixa "Namoros e gostos de Mestre Gabriel", citação [8] 0:00–0:01): "a transcrição não acompanha o áudio". A linha do tempo mostrava 0:23, mas "Em volta do trecho" ficava nas falas de 0:00/0:01 sem destaque, e a transcrição completa também não acompanhava.

## Story
Como estudante que ouve a fonte de uma resposta, quero que o painel acompanhe a fala que está tocando, para ler o que estou ouvindo.

## Scope
**In:** "Em volta do trecho" segue a fala ouvida fora do trecho citado; a transcrição completa destaca e rola até a fala ouvida e volta a seguir ao tocar de novo.
**Out:** mudar o desenho do painel (KBC-150); o player da página da faixa.

## Business rules
- BR-1: vale para qualquer reprodução desta faixa no player do app (barra, faixa do celular ou botões do painel).
- BR-2: a fala citada mantém a borda verde onde aparecer.

## Functional requirements
- FR-1: tocando fora do trecho citado, "Em volta do trecho" mostra a fala ouvida com a anterior e a seguinte, destacando a ouvida; pausado (ou de volta ao trecho), mostra de novo as falas do trecho. (BR-1, BR-2)
- FR-2: com "Transcrição completa" aberta, a fala ouvida é a atual e fica à vista (rolagem suave, instantânea com `prefers-reduced-motion`); rolar à mão para de seguir, e tocar ou pular volta a seguir. (BR-1)
- FR-3: a posição e os tempos da linha do tempo seguem andando. (BR-1)

## Acceptance criteria
- AC-1 (FR-1): Given a citação 0:00–0:01, When a faixa toca em 0:23, Then "Em volta do trecho" mostra a fala de 0:23 destacada, com a anterior e a seguinte; When pausa, Then volta às falas do trecho.
- AC-2 (FR-1, BR-2): Given a fala ouvida vizinha do trecho, Then o trecho aparece com a borda de citado.
- AC-3 (FR-2): Given a transcrição completa aberta, When a faixa toca, Then a fala ouvida fica marcada e à vista; When a pessoa rola e depois toca de novo, Then volta a seguir.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2 | unidade + E2E | `track-passage-panel.spec.ts`; `media-audio-source.spec.ts` em 1440 e 390 |
| AC-3 | unidade + E2E | idem |

## References
KBC-150 · `apps/web/src/app/features/media/track-passage/` · `apps/web/src/app/features/media/transcript/transcript-panel.ts`

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done; no open questions
- [x] Fits one goal
