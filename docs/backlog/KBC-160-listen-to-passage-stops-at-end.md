---
id: KBC-160
title: "\"Ouvir o trecho\" para no fim do trecho citado, com opção de ligar e desligar"
status: ready
slice: complete-answers
outcome: ao ouvir um trecho citado, o áudio pausa no fim do trecho (±250 ms) em 100% das vezes em que a opção está ligada; a opção vale em todos os dispositivos da pessoa
depends_on: [KBC-155, KBC-156]
---

# KBC-160 — "Ouvir o trecho" para no fim do trecho

Pedido do dono (2026-11-17): hoje "Ouvir o trecho" começa 2 s antes do trecho e segue pela faixa inteira. Deve parar no fim do trecho citado, com opção de desligar (padrão ligada).

Estado atual: `TrackPassagePanel.listen()` (`apps/web/src/app/features/media/track-passage/track-passage-panel.ts`) faz `seek(playbackStartOf(passage))` e `play()`; nada observa `passage.endMs` (só `inPassage` para o rótulo "Tocando o trecho"). `MediaEngine` (`apps/web/src/app/core/media/media-engine.ts`) não tem "parar em". As preferências de escuta da pessoa já vivem na conta: `MediaPreferences` (`libs/contracts/src/media.ts:386`, velocidade, pular silêncios, destaque de palavra), por `ListeningPreferences` com PUT parcial (KBC-045); o temporizador de sono é a única parada por tempo hoje (`core/media/sleep-timer.ts`).

## Story
Como estudante, quero ouvir só o trecho que sustenta a afirmação e o áudio parar sozinho, para conferir sem a faixa seguir falando.

## Scope
**In:** parar no fim do trecho; interruptor "Parar no fim do trecho"; persistência na conta; comportamento ao sair do trecho.
**Out:** "Faixa toda", clique em "Em volta do trecho" e outros botões de tocar (continuam tocando livre); repetir o trecho; mudar a regra do trecho (KBC-156).

## Business rules
- BR-1: com a opção ligada, o trecho iniciado por "Ouvir o trecho" (ou por ‹ › para outro trecho citado e tocar) para no `endMs` do trecho alargado (KBC-156), com tolerância de 250 ms, e o player fica pausado nesse ponto.
- BR-2: a parada vale **só** para o trecho que "Ouvir o trecho" iniciou. Se a pessoa faz seek para fora do trecho (barra de tempo, J/L, clique em uma fala em volta, outro trecho, "Faixa toda"), a parada se desarma: o áudio segue normalmente. Seek para **dentro** do trecho mantém a parada.
- BR-3: se o trecho já terminou quando a pessoa aperta "Ouvir o trecho" estando depois do fim, ele volta ao começo (2 s antes) e a parada se rearma.
- BR-4: padrão ligada. Preferência da conta, igual nos dispositivos (como `wordHighlight`: sem `.default()` no PUT parcial, para não religar uma escolha salva).
- BR-5: com a opção desligada, "Ouvir o trecho" toca como hoje.
- BR-6: ao parar, o anúncio de leitor de tela diz "Fim do trecho" (`PlayerAnnouncer`); sem som nem animação extra.

## Functional requirements
- FR-1: `MediaEngine` ganha "pausar em" (`stopAt(ms | null)`), checado pelo relógio de reprodução (`playback-clock`), cancelado por seek fora, troca de mídia, pausa e fim da faixa. (BR-1, BR-2)
- FR-2: `listen()` arma `stopAt(passage.endMs)` quando a opção está ligada. (BR-1, BR-5)
- FR-3: `MediaPreferences.stopAtPassageEnd: boolean` (contrato, PUT parcial opcional, API, `ListeningPreferences`). (BR-4)
- FR-4: o interruptor fica **no cartão do trecho**, ao lado de "Ouvir o trecho" (aparece onde a decisão é tomada; a barra do player é de todas as mídias e não conhece "trecho"). É um interruptor com rótulo "Parar no fim do trecho", estado lido por leitor de tela, alvo de toque ≥ 44 px no celular (folha de 390). Também em Configurações › Preferências › Escuta, com o mesmo estado (KBC-131). (BR-4)
- FR-5: com a parada armada, o cartão mostra "Para às m:ss" junto do tempo do trecho. (BR-1)

## Acceptance criteria
- AC-1 (FR-1, FR-2, BR-1): Given opção ligada e trecho 1:10–1:35, When toco "Ouvir o trecho", Then começa em 1:08 e pausa em 1:35 (±250 ms).
- AC-2 (BR-2, edge): Given tocando o trecho, When faço seek para 2:00, Then não pausa em 1:35 e a faixa segue.
- AC-3 (BR-2, edge): Given tocando o trecho, When faço seek para 1:20 (dentro), Then ainda pausa em 1:35.
- AC-4 (BR-5, FR-3): Given opção desligada, When toco, Then segue além de 1:35; And recarrego e continua desligada (também em outro dispositivo, pela conta).
- AC-5 (BR-4): Given conta nova, Then a opção vem ligada.
- AC-6 (BR-3): Given parei no fim e aperto "Ouvir o trecho" de novo, Then volta a 1:08 e pausa de novo em 1:35.
- AC-7 (negativo): Given a parada armada e "Faixa toda", Then toca a faixa sem parar no trecho.
- AC-8 (negativo, rede): Given o PUT da preferência falhando, Then a escolha vale na sessão e vai de novo na próxima mudança (como KBC-045).
- AC-9 (BR-6): o leitor de tela anuncia "Fim do trecho" na parada; o interruptor tem nome e estado.
- AC-10 (UI): em 1440 (painel de 460 ao lado) e 390 (folha de 85% com mini player), o interruptor cabe sem quebrar o cartão, com foco visível e alvo de toque ≥ 44 px.

## Test strategy
- AC-1..AC-3, AC-6, AC-7: unidade de `MediaEngine` (`media-engine.spec.ts`) com relógio fake e `track-passage-panel.spec.ts`.
- AC-4, AC-5, AC-8: `listening-preferences.spec.ts` e integração da API (`listening-routes`).
- AC-9, AC-10 e o fluxo completo: E2E `media-audio-source` em 1440 e 390, Chromium e WebKit (o WebKit é onde o relógio do `<audio>` mais difere: o teste mede a parada no fim com tolerância de 250 ms nos dois).

## UI references
Figma `au1MI6z2Vwy9tnqOv2vrfH`, "v2 · Pesquisa com IA — fonte de áudio": **adicionar** ao cartão do trecho o interruptor "Parar no fim do trecho" e o texto "Para às m:ss" (1440 e 390, ligado e desligado); em "v2 · Configurações — Preferências" adicionar a linha na seção de escuta. T22 em `docs/design/screens.md` ganha a emenda.

## References
`apps/web/src/app/features/media/track-passage/` · `apps/web/src/app/core/media/media-engine.ts`, `listening-preferences.ts`, `sleep-timer.ts` · `libs/contracts/src/media.ts` (`mediaPreferencesSchema`) · `apps/api/src/modules/media/listening-routes.ts` · KBC-045, KBC-155, KBC-156

## Decisões assumidas (o dono pode mudar)
- Interruptor no cartão do trecho (não no menu da barra); preferência na conta (não só no navegador).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done (KBC-155 e KBC-156 ready); no open questions
- [x] Fits one goal
