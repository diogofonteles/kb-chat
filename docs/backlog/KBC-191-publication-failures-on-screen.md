---
id: KBC-191
title: "Transcritores: o que falhou conta como falhou, com o motivo em português"
status: in-progress
slice: complete-answers
outcome: na tela Transcritores, a linha de cada acervo e a lista de falhas dizem a mesma coisa, e o motivo de cada falha se lê sem conhecer o kb
depends_on: [KBC-190]
---

# KBC-191 — O que falhou conta como falhou, com o motivo em português

## Story
Como mestre, quero que a tela Transcritores diga quantas faixas falharam e por quê, em português e sem detalhes do Mac, para saber o que fazer sem abrir logs.

## Contexto
Em 27/11, depois de 4 tentativas, as 6 gravações do hermetismo apareciam na lista de falhas. Ao mesmo tempo, a linha do acervo dizia "6 na fila · 0 falharam". O motivo de cada uma era o comando cru, com o caminho do Mac do dono: "TimeoutExpired: Command '['/Users/…/kb', 'link', …]' timed out after 1800 seconds". Depois do KBC-190, um passo parado guarda primeiro o que o kb disse e só depois o motivo. A tela, que mostra a primeira linha, mostraria a fala do kb no lugar do motivo.

## Business rules
- BR-1: um documento desistido (as tentativas acabaram e ele não foi publicado) conta em "falharam", não em "na fila". É a mesma regra da lista de falhas e do "aguardando publicação".
- BR-2: o motivo de uma falha conhecida sai em português e diz o passo:
  - parado: "o passo kb link ficou 20 min sem trabalhar e foi interrompido";
  - passou do limite: "o passo kb link passou do limite de 30 min".
  Um motivo desconhecido sai como a primeira linha do erro, como hoje.
- BR-3: nenhum motivo mostra a pasta de usuário do Mac: `/Users/<nome>` e `/home/<nome>` viram `~`.

## Acceptance criteria
- AC-1: dado um documento que falhou 4 vezes, quando o mestre abre Transcritores, então a linha do acervo o conta em "falharam" e não em "na fila", e a lista de falhas o mostra.
- AC-2: dado um "Tentar de novo", então ele volta a contar em "na fila" e sai de "falharam".
- AC-3: dado um passo parado pela vigia (KBC-190), quando a falha é mostrada (lista de falhas e página da gravação), então o motivo é "o passo kb link ficou N min sem trabalhar e foi interrompido", e não o que o kb disse antes.
- AC-4: dado o limite antigo (`TimeoutExpired … timed out after 1800 seconds`) ou o de um download (`took more than N s`), então o motivo diz o passo, quando há um, e o limite em minutos.
- AC-5: dado um motivo com a pasta de usuário do Mac, então ele aparece com `~`.

## References
`apps/api/src/adapters/sqlite/sqlite-media-document-store.ts` (`countsOf`, `failed`), `apps/api/src/modules/media-documents/publication-status.ts` (`reasonOf`); KBC-100 FR-3, KBC-190.
