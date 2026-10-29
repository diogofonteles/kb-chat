---
id: KBC-057
title: "Offline de listas: baixar uma playlist ou as Favoritas inteiras e mantê-las em dia, remover as ouvidas automaticamente e sincronizar marcadores e favoritas feitos sem rede"
status: ready
slice: phase-2-library
outcome: quem estuda liga "Baixar" numa playlist uma vez e, a cada abertura com rede, o aparelho fica com o curso inteiro em dia, sem baixar mídia por mídia
depends_on: [KBC-056, KBC-054, KBC-052, KBC-042]
---

# KBC-057 — Offline de playlists e Favoritas, com sincronização

## Story
Como quem estuda fora de casa, quero ligar "Baixar" numa playlist ou nas Favoritas e saber que o aparelho acompanha o que eu mudar nelas, e que o que eu marcar ou anotar sem rede chega à minha conta depois, para não ter de cuidar de cada download.

## Scope
**In:** chave **Baixar** na página da playlist e de Favoritas, com o tamanho total e o que falta; sincronização ao abrir o app com rede e a cada 24 h aberto (novos itens baixados, itens removidos apagados); **Remover baixadas depois de ouvidas** (preferência do aparelho, desligada por padrão); selo "Baixada" e o estado da lista ("Baixando 3 de 12", "Tudo baixado", "Faltam 2: sem espaço"); marcadores (KBC-042), favoritas e "Marcar como ouvida" feitos sem rede guardados no aparelho e enviados ao voltar a rede, na ordem.
**Out:** baixar pastas inteiras; baixar com o app fechado; criar ou editar playlists sem rede (ficam só leitura offline, com o aviso "Sem conexão: as playlists não podem ser editadas agora.").

## Business rules
- BR-1: regra do dono (2026-10-28): baixar listas exige a permissão nova `media-offline-lists` ("Baixar playlists e favoritas"), além de `media-offline` e da permissão da lista (`media-playlists` ou `media-favorites`); masters têm todas; convites e perfis não a concedem por padrão.
- BR-2: uma lista com **Baixar** ligado mantém no aparelho todas as mídias que a pessoa vê nela; cada mídia segue as regras de licença, aparelhos e espaço do KBC-056 (BR-2 a BR-6).
- BR-3: uma mídia sai do aparelho quando não está mais em nenhuma lista baixada **e** não foi baixada sozinha; uma mídia em duas listas baixadas é guardada uma vez só.
- BR-4: quando o espaço acaba no meio da sincronização, o app baixa na ordem da lista até onde couber e mostra "Faltam N: sem espaço neste aparelho." com **Ver Baixadas**; nada é apagado para abrir espaço sem a pessoa pedir.
- BR-5: **Remover baixadas depois de ouvidas** apaga do aparelho uma mídia que chega a "Ouvida" (KBC-041 BR-2), mesmo numa lista baixada; ela não volta a baixar enquanto continuar ouvida.
- BR-6: ações feitas sem rede (criar, editar ou apagar marcador; favoritar ou desfavoritar; marcar como ouvida ou não ouvida) ficam guardadas no aparelho e são enviadas ao voltar a rede, na ordem em que foram feitas; uma ação recusada pela API (por exemplo, acesso perdido) é descartada com o aviso "Não consegui salvar <ação> em '<título>': <motivo>." e não bloqueia as outras.
- BR-7: um marcador criado offline num aparelho e outro criado na mesma mídia em outro aparelho são dois marcadores (nunca um sobrescreve o outro); editar a mesma nota em dois aparelhos fica com a edição mais recente pelo relógio do servidor.
- BR-8: vale igual para áudio e vídeo; numa lista baixada, cada vídeo segue a escolha "Vídeo (720p)" ou "Só o áudio" da lista (padrão "Só o áudio", mostrado ao ligar).

## Functional requirements
- FR-1: `PUT/DELETE /api/v1/media/offline-lists` com `{ deviceId, list: "favorites" | "playlist:{id}", videoAs: "video" | "audio" }` devem ligar e desligar o download da lista neste aparelho; `GET …?device=` deve listar as listas ligadas. (BR-1, BR-8)
- FR-2: a sincronização deve calcular, para o aparelho, o conjunto desejado (BR-2, BR-3, BR-5), pedir as licenças que faltam, enfileirar os downloads (2 ao mesmo tempo, KBC-056) e apagar o que sobra, e mostrar o estado de cada lista. (BR-2 a BR-5)
- FR-3: o web deve guardar as ações da BR-6 no IndexedDB (`pending`, ADR 0026 §2) com um id idempotente por ação e enviá-las em ordem ao voltar a rede; a API deve aceitar o id idempotente (`Idempotency-Key`) em marcadores, favoritas e ouvidas, sem duplicar. (BR-6, BR-7)
- FR-4: a página da playlist e de Favoritas deve ter a chave **Baixar** (`role="switch"`) com "12 mídias · 1,2 GB · faltam 300 MB", a escolha do vídeo e o estado da sincronização em texto. (BR-4, BR-8)
- FR-5: Baixadas (T19) deve ter **Remover baixadas depois de ouvidas** (desligada) e agrupar por lista baixada. (BR-5)

## Non-functional requirements
- NFR-1: sincronizar uma lista de 50 mídias já baixadas sem mudanças leva ≤ 2 s e não baixa nenhum byte de mídia (só a consulta de licenças).
- NFR-2: 200 ações offline enfileiradas chegam à conta em ≤ 30 s ao voltar a rede, sem duplicar nenhuma (teste de integração com reenvio forçado).

## Acceptance criteria
- **AC-1** (FR-1, FR-2, FR-4): Given a playlist "Curso" com 3 mídias, When a pessoa liga **Baixar**, Then as 3 baixam e a playlist mostra "Tudo baixado".
- **AC-2** (FR-2, BR-2): Given "Curso" baixada, When a pessoa adiciona uma 4ª mídia em outro aparelho e abre o app neste com rede, Then a 4ª baixa sozinha.
- **AC-3** (BR-3): Given uma mídia em "Curso" e em Favoritas, ambas baixadas, When ela sai de "Curso", Then continua no aparelho; When sai também de Favoritas, Then é apagada no próximo contato.
- **AC-4** (BR-3): Given uma mídia baixada sozinha e também em "Curso", When a pessoa desliga **Baixar** em "Curso", Then a mídia continua baixada.
- **AC-5** (BR-4): Given espaço para 2 das 3 mídias, When a sincronização roda, Then as 2 primeiras baixam e a lista mostra "Faltam 1: sem espaço neste aparelho." sem apagar nada.
- **AC-6** (BR-5, FR-5): Given **Remover baixadas depois de ouvidas** ligado, When uma mídia de "Curso" chega a 95%, Then ela é apagada do aparelho e não volta a baixar.
- **AC-7** (BR-6, FR-3): Given o aparelho sem rede, When a pessoa cria um marcador com nota, favorita uma mídia e marca outra como ouvida, Then tudo aparece no aparelho; When a rede volta, Then as três ações chegam à conta, na ordem, e aparecem em outro aparelho.
- **AC-8** (BR-6): Given um marcador criado offline numa mídia cujo acervo a pessoa perdeu, When a rede volta, Then aparece o aviso "Não consegui salvar o marcador em '<título>': você não tem mais acesso a este acervo." e as outras ações seguem.
- **AC-9** (BR-7, FR-3): Given a mesma ação reenviada duas vezes (rede caiu na resposta), When a API recebe as duas, Then o marcador existe uma vez só.
- **AC-10** (BR-8): Given uma playlist com um vídeo e a escolha padrão, When a pessoa liga **Baixar**, Then vê "Vídeos: só o áudio" e o vídeo baixa como áudio.
- **AC-11** (BR-1): Given uma pessoa com `media-offline` e sem `media-offline-lists`, When abre uma playlist, Then não há a chave **Baixar**, e `PUT /offline-lists` responde 403.
- **AC-12** (escopo): Given o aparelho sem rede, When a pessoa tenta renomear uma playlist, Then vê "Sem conexão: as playlists não podem ser editadas agora." e nada muda.
- **AC-13** (acessibilidade): Given só o teclado e um leitor de tela, When a pessoa liga e desliga **Baixar** e a preferência de remover ouvidas, Then o estado é anunciado ("Baixar ligado, 12 mídias"), e não há violações sérias do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-5, AC-6, AC-10 | unitário (cálculo do conjunto desejado) + E2E | fast-check no cálculo; espaço simulado |
| AC-3, AC-4 | unitário + integração | |
| AC-7, AC-8, AC-9, NFR-2 | integração (API com `Idempotency-Key`) + E2E offline | Dois contextos, mesma conta |
| AC-11 | integração | Conta sem a permissão |
| AC-12 | componente + E2E | |
| AC-13 | E2E | axe |
| NFR-1 | E2E com medição | Conta requisições de mídia |

## References
ADR: [0026](../adr/0026-offline-media-downloads.md) · KBC-056 (licenças, aparelhos, espaço), KBC-054 (playlists), KBC-052 (Favoritas), KBC-042 (marcadores) · Tela: `docs/design/screens.md` T17 (chave Baixar) e T19 · Benchmark: [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md) §1.4

## Decisões assumidas (o dono pode mudar)
- Em listas, vídeos baixam como "Só o áudio" por padrão (30 MB/h em vez de 400 MB/h); a pessoa troca na hora de ligar.
- Sem rede, playlists ficam só leitura (editar offline exigiria resolver conflitos de ordem entre aparelhos).

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
