---
id: KBC-056
title: "Baixar para ouvir offline: baixar um áudio ou vídeo (ou só o áudio do vídeo), tocar sem rede com legenda e transcrição, tela \"Baixadas\" com espaço e aparelhos, e cópias que expiram ou são apagadas quando o acesso acaba"
status: ready
slice: phase-2-library
outcome: quem estuda ouve uma palestra baixada no modo avião, com legenda e transcrição, e quem perde o acesso deixa de tê-la no app
depends_on: [KBC-051, KBC-035]
---

# KBC-056 — Baixar para ouvir offline

## Story
Como quem estuda no trajeto, em viagem ou com sinal fraco, quero baixar palestras (áudio ou vídeo) no aparelho e ouvi-las sem internet, com a legenda e a transcrição, para não depender da rede.

## Scope
**In:** o primeiro service worker do app (casca do app offline e mídia baixada, ADR 0026); **Baixar** (⤓) na linha da Biblioteca, no player e no menu ⋯; para vídeo, a escolha **Vídeo (720p)** ou **Só o áudio**, com os tamanhos; download retomável em partes de 8 MB enquanto o app está aberto (até 2 ao mesmo tempo, o resto em espera); progresso, **Pausar**, **Continuar**, **Cancelar**; tela **Baixadas** (T19) com as mídias, o espaço usado e livre, **Remover** uma ou todas, o limite do aparelho e a lista de aparelhos (renomear, remover); chip "Baixadas" na Biblioteca; app abre sem rede direto em Baixadas; tocar sem rede com busca na barra, legenda e transcrição; posições gravadas offline e enviadas ao voltar a rede (KBC-041); permissão de armazenamento persistente; licença (grant) que expira em 30 dias sem contato e é revogada quando o acesso acaba; liga/desliga `KB_CHAT_OFFLINE`.
**Out:** baixar playlists e Favoritas inteiras, sincronização automática e limpeza das ouvidas (KBC-057); marcadores criados offline (KBC-057); baixar com o app fechado (Background Fetch não existe no Safari); "só no Wi-Fi" (o Safari não informa o tipo de rede); criptografar o arquivo no aparelho (ADR 0026, opção rejeitada).

## Business rules
- BR-1: regra do dono (2026-10-28): baixar exige a permissão nova `media-offline` ("Baixar para ouvir offline"), além de `media`; masters têm todas; convites e perfis não a concedem por padrão. Sem ela, não há ⤓ nem "Baixadas", e nenhum service worker é registrado para a pessoa.
- BR-2: só se baixa mídia pronta de um acervo que a pessoa vê; cada download pede à API uma licença (grant) para este aparelho, válida por 30 dias e renovada a cada contato.
- BR-3: até **5 aparelhos** por pessoa; o 6º é recusado com "Você já baixa mídias em 5 aparelhos. Remova um em Baixadas para usar este." e a lista de aparelhos.
- BR-4: limite de espaço por aparelho, padrão **5 GB** (a pessoa pode diminuir; um master pode aumentar por pessoa); um download que passaria do limite, ou deixaria menos de 500 MB livres no aparelho, é recusado antes de começar, com o tamanho e o que falta.
- BR-5: a licença é **revogada** quando a pessoa perde `media-offline` ou `media`, perde o acervo, a mídia é removida ou o aparelho é removido; no primeiro contato com a API, o app apaga a cópia em até 60 s e avisa "'<título>' foi removida das Baixadas: <motivo>.".
- BR-6: sem contato com a API por 30 dias, as mídias baixadas param de tocar ("Conecte-se à internet para continuar ouvindo as mídias baixadas.") e voltam a tocar no próximo contato, se a licença ainda valer.
- BR-7: uma mídia baixada leva junto as legendas e a transcrição que existirem no momento; se a transcrição mudar (nova versão), a cópia é atualizada no próximo contato.
- BR-8: com rede, uma mídia baixada toca da cópia do aparelho (sem gastar dados); sem a cópia completa, toca da rede como hoje.
- BR-9: ao sair da conta, o app pergunta "Apagar as mídias baixadas neste aparelho?" (**Apagar** em foco, **Manter**); outra pessoa que entrar no mesmo navegador nunca toca as cópias de quem saiu.
- BR-10: vale igual para áudio e vídeo; "Só o áudio" de um vídeo baixa a cópia de áudio (ADR 0022 §4) e toca como áudio, com a mesma legenda e transcrição.

## Functional requirements
- FR-1: `POST /api/v1/media/{id}/offline-grants` (`deviceId`, `deviceName`, `rendition`) deve aplicar BR-1 a BR-4 e devolver o grant com `expiresAt`, o tamanho e o `ETag` da cópia; `GET /api/v1/media/offline-grants?device=` deve devolver os grants do aparelho com o estado (`active`, ou `revoked` com o motivo); `GET/PATCH/DELETE /api/v1/media/offline-devices` devem listar, renomear e remover aparelhos da pessoa. (BR-2 a BR-5)
- FR-2: o web deve baixar a cópia com `Range` em partes de 8 MB, conferir o `ETag` e o tamanho de cada parte, guardar cada parte no IndexedDB antes de pedir a seguinte, retomar da primeira parte que falta ao reabrir o app, e recomeçar do zero se o `ETag` mudar. (ADR 0026 §3)
- FR-3: o service worker deve responder `GET …/stream` e `…/subtitles.vtt` de uma mídia baixada com licença válida a partir do IndexedDB (`206` com `Content-Range` para pedidos com `Range`, `200` sem), e passar à rede, sem mudar nada, tudo o mais. (BR-6, BR-8)
- FR-4: o service worker deve guardar a casca do app da versão atual e abrir o app sem rede; sem rede, a lateral mostra só **Baixadas** e o player; as outras telas mostram "Sem conexão. Só as mídias baixadas estão disponíveis." com **Ir para Baixadas**. Uma versão nova mostra "Nova versão disponível" com **Atualizar**, nunca recarrega sozinha durante a reprodução.
- FR-5: o app deve revalidar os grants ao abrir com rede e a cada 24 h aberto, apagar cópias revogadas (BR-5) e renovar `expiresAt`. (BR-5, BR-6)
- FR-6: antes de cada download, o web deve conferir `navigator.storage.estimate()` e o limite do aparelho (BR-4); no primeiro download, pedir `navigator.storage.persist()` e, se negado, mostrar em Baixadas "O navegador pode apagar as mídias baixadas se faltar espaço." (no iPhone, com a dica "Adicione o app à tela de início para guardar com mais segurança."). (BR-4)
- FR-7: a tela **Baixadas** (T19) deve mostrar cada mídia com estado ("Baixando… 41% · 120 de 290 MB", "Na espera", "Pausada", "Baixada · 290 MB", "Falhou: …", "Expirada", "Precisa baixar de novo"), as ações por estado, o total usado / limite / livre no aparelho, **Remover todas** com confirmação, e a seção **Aparelhos**.
- FR-8: o player deve tocar a cópia offline com busca na barra, velocidade, pulos, legenda e transcrição clicável; a posição gravada offline deve ser enviada ao voltar a rede (fila do KBC-041), vencendo a mais recente pelo relógio do servidor.
- FR-9: com `KB_CHAT_OFFLINE=off`, a API não registra as rotas do FR-1 e serve um `/sw.js` que se desregistra e apaga as caches do app. (ADR 0026)
- FR-10: o menu ⤓ de um vídeo deve oferecer **Vídeo (720p) · <tamanho>** e **Só o áudio · <tamanho>**. (BR-10)

## Non-functional requirements
- NFR-1: no modo avião, uma mídia baixada (áudio de 2 h e vídeo de 1 h) abre do início do app em ≤ 3 s e um pulo para qualquer minuto toca em ≤ 500 ms (E2E no Chrome e no WebKit; aparelho real antes da produção).
- NFR-2: um download de 400 MB interrompido aos 60% (aba fechada ou rede caída) termina sem baixar de novo mais de 8 MB do que já tinha.
- NFR-3: o download não piora a reprodução de outras pessoas: com 2 downloads de vídeo em andamento, o stream de outra conta mantém p95 do primeiro byte ≤ 300 ms (teste de carga no staging).
- NFR-4: cobertura ≥ 90% e Stryker ≥ 80% no service worker (montagem da resposta parcial, escolha cópia/rede) e na máquina de estados do download; fast-check nos limites das partes.
- NFR-5: nenhum dado de outra pessoa é servido pelo service worker (teste com duas contas no mesmo navegador).

## Acceptance criteria
- **AC-1** (FR-1, FR-2, FR-7): Given uma pessoa com `media-offline`, When baixa um áudio de 30 min, Then Baixadas mostra o progresso real e, ao fim, "Baixada · 15 MB", e o chip "Baixadas" da Biblioteca a lista.
- **AC-2** (FR-3, FR-4, FR-8, NFR-1): Given a mídia baixada, When o aparelho fica sem rede e a pessoa reabre o app, Then o app abre em Baixadas, a mídia toca, um pulo para 20:00 toca em ≤ 500 ms, e a legenda e a transcrição funcionam.
- **AC-3** (FR-10, BR-10): Given um vídeo de 10 min, When a pessoa escolhe **Só o áudio**, Then baixa só a cópia de áudio, e sem rede ela toca como áudio, com a legenda; When escolhe **Vídeo (720p)**, Then sem rede o vídeo aparece no player.
- **AC-4** (FR-2, NFR-2): Given um download de vídeo em 60%, When a pessoa fecha a aba e reabre o app, Then o download continua da parte em que parou e a mídia é criada uma vez só.
- **AC-5** (FR-2): Given um download em andamento, When a cópia no servidor muda (novo `ETag`), Then o download recomeça do zero e a cópia antiga nunca toca misturada.
- **AC-6** (BR-5, FR-5): Given uma mídia baixada, When um master tira o acervo da pessoa e ela abre o app com rede, Then em até 60 s a cópia some e o aviso diz "… foi removida das Baixadas: você não tem mais acesso a este acervo.".
- **AC-7** (BR-5): Given uma mídia baixada, When a pessoa perde `media-offline`, Then no próximo contato todas as cópias são apagadas, ⤓ e Baixadas somem, e o service worker é desregistrado.
- **AC-8** (BR-6): Given o relógio do aparelho 31 dias depois do último contato, sem rede, When a pessoa toca uma mídia baixada, Then vê "Conecte-se à internet para continuar ouvindo as mídias baixadas." e nada toca; When a rede volta e a licença vale, Then toca de novo.
- **AC-9** (BR-3, FR-1): Given 5 aparelhos com downloads, When a pessoa baixa num 6º, Then vê a mensagem do limite com a lista de aparelhos; When remove um aparelho, Then o download no novo é aceito e o aparelho removido perde as cópias no próximo contato.
- **AC-10** (BR-4, FR-6): Given 4,9 GB usados de 5 GB, When a pessoa baixa um vídeo de 400 MB, Then vê "Este download passa do limite de 5 GB deste aparelho. Remova algo em Baixadas ou baixe só o áudio (30 MB)." e nada é baixado.
- **AC-11** (BR-8): Given uma mídia baixada e a rede ligada, When a pessoa a toca, Then nenhuma requisição de `…/stream` sai para a rede.
- **AC-12** (BR-9, NFR-5): Given cópias baixadas por A, When A sai e escolhe **Apagar**, Then as cópias somem; Given A escolheu **Manter** e B entra no mesmo navegador, When B pede a mesma mídia, Then o service worker não serve a cópia de A.
- **AC-13** (FR-4): Given o app sem rede, When a pessoa abre a busca de documentos, Then vê "Sem conexão. Só as mídias baixadas estão disponíveis." com **Ir para Baixadas**.
- **AC-14** (FR-4): Given uma versão nova publicada enquanto a pessoa ouve, When o service worker a instala, Then aparece "Nova versão disponível" com **Atualizar**, e a reprodução não para.
- **AC-15** (FR-8): Given uma mídia ouvida offline até 15:00, When a rede volta, Then a posição 15:00 chega à conta e outro aparelho mostra "Continuar de 15:00".
- **AC-16** (FR-6): Given o navegador negou o armazenamento persistente, When a pessoa abre Baixadas, Then vê o aviso de que o navegador pode apagar as mídias (e, no iPhone, a dica da tela de início); Given uma parte apagada pelo navegador, Then a mídia mostra "Precisa baixar de novo" com **Baixar de novo**.
- **AC-17** (BR-1, FR-9): Given uma pessoa sem `media-offline`, When abre o app, Then não há ⤓ nem Baixadas, nenhum service worker é registrado, e `POST …/offline-grants` responde 403; Given `KB_CHAT_OFFLINE=off`, Then a rota não existe e o `/sw.js` se desregistra.
- **AC-18** (BR-7): Given uma mídia baixada sem transcrição, When a transcrição fica pronta e a pessoa abre o app com rede, Then a cópia ganha a legenda e a transcrição sem baixar o áudio de novo.
- **AC-19** (acessibilidade): Given só o teclado e um leitor de tela, When a pessoa baixa, pausa, continua, cancela, remove e gerencia aparelhos, Then tudo funciona, o progresso é anunciado a cada 25% (não a cada parte), e não há violações sérias do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-3, AC-11, AC-13, AC-14 | E2E | Chrome e WebKit; áudio e vídeo reais gerados por ffmpeg |
| AC-2, NFR-1 | E2E (`context.setOffline(true)`) + aparelho real | iPhone (Safari e tela de início) e Android antes da produção; resultado no `qa.md` |
| AC-4, AC-5, NFR-2 | unitário (máquina de estados do download) + E2E | Rede cortada por `route.abort` no meio; `ETag` trocado pelo servidor de teste |
| AC-6, AC-7, AC-9, AC-17 | integração (API) + E2E | Revogação por cada motivo |
| AC-8 | unitário (relógio falso) + E2E (`page.clock`) | |
| AC-10, AC-16 | componente + E2E | `storage.estimate` e `persist` simulados |
| AC-12, NFR-5 | E2E | Duas contas no mesmo contexto de navegador |
| AC-15 | E2E | Dois contextos, mesma conta |
| AC-18 | integração + E2E | Transcrição publicada depois do download |
| AC-19 | E2E | axe |
| NFR-3 | carga no staging (Mac) | k6 ou script com 2 downloads + 1 stream |
| NFR-4 | unitário + Stryker + fast-check | Montagem de `206` nas bordas das partes |

## References
ADR: [0026](../adr/0026-offline-media-downloads.md) (decisão, ameaças e conformidade), [0022](../adr/0022-media-library-store-queue-and-streaming.md), [0025](../adr/0025-own-media-player-for-audio-and-video.md) · Tela: `docs/design/screens.md` T19 (Baixadas) e T16 (chip e ⤓) · KBC-035 (vídeo e cópia de áudio), KBC-038 (legendas), KBC-041 (posições) · Benchmark: [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md) §1.4 e §4 · Barra de qualidade da fase 2: `docs/backlog/README.md`

## Decisões assumidas (o dono pode mudar)
- Limites no modelo do Spotify, ajustados ao tamanho do produto: 5 aparelhos por pessoa, licença de 30 dias, 5 GB por aparelho (≈ 170 h de áudio ou 12 h de vídeo).
- O arquivo baixado não é criptografado: a mídia já é só entre usuários do app, e criptografar no navegador não impede quem controla o aparelho (ADR 0026).
- Sair da conta oferece apagar as baixadas, com **Apagar** como padrão.

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
