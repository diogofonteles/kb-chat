---
id: KBC-155
title: "Fonte de áudio com um controle só e citações da mesma faixa agrupadas"
status: ready
slice: ui-v2-areas
outcome: na fonte de áudio só a barra do player (ou o mini player da folha, no celular) controla a reprodução, e citações seguidas da mesma faixa viram uma pílula só
depends_on: [KBC-150, KBC-154]
---

# KBC-155 — Fonte de áudio com um controle só

Pedido do dono (2026-11-17), olhando o painel tocando com "Pausar", selo "tocando" e barra 0:12/3:00 e, embaixo, a barra do player com os mesmos controles: "qual o sentido de termos na mesma página dois players?". Decisões: "só a barra controla" e "agrupar citações". Achado da QA do KBC-151: em 390, com a folha de leitura aberta, o controle de tocar fica atrás da folha.

## Story
Como estudante que ouve a fonte de uma resposta, quero um único controle de reprodução e as citações da mesma faixa juntas, para não me perguntar qual player usar nem caçar tempos espalhados.

## Scope
**In:** cartão do trecho com uma ação ("Ouvir o trecho") e o estado "tocando no player"; sai a linha do tempo do painel; as marcas viram "Outros trechos citados"; no celular, o mini player no pé da folha, sempre alcançável; na resposta, pílula agrupada com um botão por tempo; frames do Figma.
**Out:** player da página da faixa; transcrição completa; chip da faixa no fim da resposta; citações de texto.

## Business rules
- BR-1: um transporte por tela: a barra do player (desktop) ou o mini player (celular, no pé da folha enquanto ela está aberta). O painel não tem "Pausar" nem barra de progresso.
- BR-2: "Ouvir o trecho" e "Faixa toda" só começam a tocar; "Faixa toda" aparece apenas parado.
- BR-3: citações seguidas da mesma faixa (separadas só por espaço, vírgula ou ponto e vírgula) são uma pílula; cada tempo é um botão próprio; tempos repetidos aparecem uma vez.
- BR-4: citações de texto e a citação isolada de uma faixa não mudam.

## Functional requirements
- FR-1: parado, o cartão mostra "Ouvir o trecho" (e "Faixa toda" no desktop), marcar e compartilhar. (BR-1, BR-2)
- FR-2: com esta faixa tocando dentro do trecho, o cartão mostra "tocando no player" em vez do botão; tocando fora do trecho, "Ouvir o trecho" volta e leva ao trecho. (BR-1)
- FR-3: a seção "Outros trechos citados" lista os outros trechos desta faixa na resposta ([n] tempo); cada um escolhe o trecho e posiciona o player. Sem outros, a seção não aparece. (BR-1)
- FR-4: no celular, com a folha aberta e a faixa pronta, o mini player fica fixo no pé da folha, tocando ou pausado, com Tocar/Pausar no player do app. (BR-1)
- FR-5: na resposta, a pílula agrupada mostra "〰n Título · 1:16, 1:21, 0:48"; cada tempo abre aquele trecho, o aberto fica verde, e o leitor de tela ouve "Ouvir Título aos 1 minuto e 16 segundos". (BR-3, BR-4)

## Acceptance criteria
- AC-1 (FR-1, FR-2, BR-1): Given o painel aberto no desktop, When "Ouvir o trecho" toca, Then o cartão diz "tocando no player", não há "Pausar" nem barra de progresso no painel, e a barra do player pausa.
- AC-2 (FR-2, edge): Given a faixa tocando fora do trecho, Then "Ouvir o trecho" aparece e leva ao trecho.
- AC-3 (FR-1, BR-2, negative): Given a faixa tocando, Then "Faixa toda" não aparece; parado, aparece.
- AC-4 (FR-3): Given duas citações da faixa, When clico "Outro trecho citado, em 0:50", Then o cartão mostra 0:50 e o player vai a 0:48; Given uma citação só, Then não há "Outros trechos citados".
- AC-5 (FR-4): Given 390 com a folha aberta, When a faixa toca e depois pausa, Then o mini player da folha está visível e clicável nos dois estados (Pausar / Tocar), sem nada por cima.
- AC-6 (FR-5): Given "[2@0:50], [2@0:41]", Then uma pílula com dois links ("Ouvir Título aos 50 segundos", "… aos 41 segundos"); When clico 0:41, Then o painel abre em 0:41 e só esse tempo fica verde.
- AC-7 (BR-4, negative): Given "[1]" de texto, "[2@0:41]" sozinha, uma faixa sem trecho salvo ou citações de faixas diferentes lado a lado, Then a renderização é a de antes.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1–AC-4 | unidade + E2E | `track-passage-panel.spec.ts`; `media-audio-source.spec.ts` 1440 e 390, Chromium e WebKit |
| AC-5 | unidade + E2E | idem, 390 |
| AC-6, AC-7 | unidade + E2E | `answer-format.spec.ts`, `research-message.spec.ts`; `media-audio-source.spec.ts` |

## References
T22 em `docs/design/screens.md` (emenda KBC-155) · Figma "v2 · Pesquisa com IA — fonte de áudio" · KBC-150 · KBC-154 · `apps/web/src/app/features/media/track-passage/` · `apps/web/src/app/features/answer/answer-format.ts`

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done; no open questions
- [x] Fits one goal
