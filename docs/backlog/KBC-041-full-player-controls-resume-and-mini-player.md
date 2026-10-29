---
id: KBC-041
title: "Player completo: velocidade, volume, atalhos de teclado, controles do sistema, retomar de onde parou e mini-player persistente"
status: done
slice: phase-2-a
outcome: quem estuda ouve palestras longas no ritmo que quer, controla pelo teclado, pela tela de bloqueio ou pelo fone, e continua de onde parou em qualquer aparelho
depends_on: [KBC-034]
---

# KBC-041 — Player completo

## Story
Como quem estuda palestras de 1 a 2 horas, quero controlar a velocidade, usar o teclado, os botões do fone e a tela de bloqueio, continuar de onde parei em outro aparelho e seguir ouvindo enquanto busco, para estudar sem perder o fio.

## Scope
**In:** velocidade 0,75×–2× guardada na conta; volume e mudo (só com ponteiro fino); atalhos de teclado e o diálogo "Atalhos de teclado"; Media Session API (tela de bloqueio, central de controle, botões do fone, `setPositionState`); posição salva na conta por mídia e "Continuar de"; mídia ouvida (≥ 95%); mini-player persistente ao navegar pelo app; título da aba com "▶ " ao tocar; tempo restante ↔ duração total.
**Out:** legendas, CC e transcrição (KBC-038); `?t=` (KBC-038); listas de reprodução; baixar o áudio; vídeo (KBC-035).

## Business rules
- BR-1: a velocidade escolhida vale para todas as mídias da pessoa, em todos os aparelhos, até ela mudar.
- BR-2: a posição é por pessoa e por mídia. Chegar a 95% da duração ou ao fim zera a posição e marca a mídia como ouvida.
- BR-3: o player nunca começa a tocar sozinho ao abrir uma mídia; só depois de um gesto da pessoa (tocar, "Continuar de", clique num trecho ou num resultado).
- BR-4: um minuto pedido explicitamente (`?t=` ou resultado da busca, KBC-038/KBC-039) vence a posição salva.
- BR-5: atalhos de uma tecla só agem na página do player e no mini-player, nunca com o foco em `input`, `textarea`, `select`, `[contenteditable]`, item de menu ou diálogo, e a pessoa pode desligá-los (WCAG 2.1.4).

## Functional requirements
- FR-1: `GET /api/v1/media/preferences` e `PUT /api/v1/media/preferences` devem ler e gravar a velocidade (um dos 6 valores, senão `VALIDATION_FAILED`) e a escolha de tempo restante ou total da pessoa. (BR-1)
- FR-2: `PUT /api/v1/media/{id}/progress` deve gravar a posição em ms (0 ≤ posição ≤ duração) com as mesmas regras de acesso do stream (404 sem acesso); a lista e o detalhe da mídia devem devolver `positionMs` e `completedAt` da pessoa. (BR-2)
- FR-3: Enquanto toca, o web deve guardar a posição no navegador a cada 1 s e enviá-la à API a cada 10 s, ao pausar, ao trocar de mídia, quando a aba fica oculta (`visibilitychange`) e ao fechar a página (`pagehide`, `fetch` com `keepalive`), sem enviar duas vezes a mesma posição. Se o envio falhar, a posição local é reenviada depois; entre aparelhos vence a gravação mais recente pelo relógio do servidor.
- FR-4: Ao abrir uma mídia com posição salva > 0, o player deve oferecer "Continuar de m:ss" e "Começar do início", sem tocar. (BR-3, BR-4)
- FR-5: A velocidade deve ser reaplicada a cada carga de mídia em `defaultPlaybackRate` e `playbackRate` (o algoritmo de carga do HTML volta a velocidade ao padrão), com `preservesPitch` ligado; o menu marca a atual com ✓ e texto; os atalhos sobem e descem um degrau sem dar a volta.
- FR-6: Os atalhos de `docs/design/screens.md` T15 (Espaço/K, J, L, ←/→, Shift+, e Shift+., M, C, 0–9, ?) devem agir uma vez por tecla, respeitar a BR-5, não duplicar as teclas consumidas pelo controle focado e ser declarados em `aria-keyshortcuts`. O diálogo "Atalhos de teclado" deve listar todos e ter **Usar atalhos de uma tecla** (ligado por padrão, guardado no navegador).
- FR-7: Quando o navegador oferece a Media Session API, o web deve publicar título, autoria e ícones (96 a 512 px), tratar `play`, `pause`, `seekbackward` (15 s, ou o `seekOffset` pedido), `seekforward` (30 s, idem), `seekto` (com `fastSeek` quando pedido) e `stop`, chamar `setPositionState` em `loadedmetadata`, `play`, `pause`, `seeked` e `ratechange` (duração > 0, posição ≤ duração), atualizar `playbackState` e limpar tudo ao fechar o player.
- FR-8: Ao sair de `/midia/{id}` com o áudio tocando, a reprodução deve continuar sem corte e o mini-player deve aparecer no pé da área principal (acima da caixa de pergunta no celular). "Fechar o player" pausa, salva a posição e some.
- FR-9: O volume e o mudo devem aparecer só quando o navegador deixa mudar o volume, verificado ao abrir (mudar o volume de um elemento de teste e esperar `volumechange`); no iPhone e no iPad ficam escondidos. O volume escolhido é lembrado no navegador.
- FR-10: Uma região `role="status"` deve anunciar só mudanças confirmadas (tocar, pausar, velocidade, legendas, a posição depois de um pulo), juntar pulos seguidos num anúncio e ficar quieta enquanto a barra de progresso está focada.
- FR-11: Com o mini-player aberto, a área principal deve reservar a altura dele (`scroll-padding-bottom` e margem), para que nenhum elemento focado fique escondido atrás dele (WCAG 2.4.11).

## Non-functional requirements
- NFR-1: trocar de rota com o áudio tocando não causa interrupção audível: `currentTime` nunca recua nem para por mais de 250 ms durante a navegação (medido no E2E).
- NFR-2: no máximo 1 gravação de posição a cada 10 s por mídia tocando (medido pelas requisições no E2E).
- NFR-3: nenhum vazamento: abrir e fechar 20 mídias seguidas deixa um único elemento `<audio>` e nenhum ouvinte de evento a mais (teste de componente).
- NFR-4: cada interação (tocar, pular, mudar velocidade) responde em ≤ 100 ms (INP ≤ 200 ms medido no E2E).

## Acceptance criteria
- **AC-1** (FR-1, FR-5, BR-1): Given a velocidade 1× , When a pessoa escolhe 1,5× e abre outra mídia, Then a nova toca em 1,5×; When entra em outro navegador com a mesma conta, Then o menu mostra 1,5×.
- **AC-2** (FR-1): Given a API, When recebe `PUT /media/preferences` com velocidade 3, Then responde 400 `VALIDATION_FAILED` e nada muda.
- **AC-3** (FR-2, FR-3, FR-4): Given uma mídia ouvida até 23:10 e pausada, When a pessoa a abre de novo (outro aparelho), Then vê "Continuar de 23:10" sem som, e o clique toca a partir de 23:10 (±1 s).
- **AC-4** (BR-2): Given uma mídia tocando, When chega a 95% da duração, Then a posição é zerada, a lista não mostra "Continuar de" e a mídia fica marcada como ouvida.
- **AC-5** (FR-2): Given uma pessoa sem acesso ao acervo, When envia `PUT /media/{id}/progress`, Then recebe 404; com posição negativa ou maior que a duração, 400.
- **AC-6** (FR-6, BR-5): Given o player aberto com o foco fora de campos, When a pessoa aperta K, L, J, Shift+. e M, Then toca, avança 30 s, volta 15 s, sobe para a próxima velocidade e silencia, cada um uma vez.
- **AC-7** (BR-5): Given o foco na caixa de pergunta, When a pessoa digita "k" e espaço, Then o texto é digitado e o player não muda; Given "Usar atalhos de uma tecla" desligado, When aperta K na página do player, Then nada muda.
- **AC-8** (FR-6): Given o foco na barra de progresso, When a pessoa aperta →, Then a posição avança só 5 s (sem disparar o atalho global também).
- **AC-9** (FR-7): Given um navegador com Media Session, When o sistema envia `seekforward` e `seekto` 600 s, Then a posição vai a +30 s e depois a 10:00, e `setPositionState` reflete posição, velocidade e duração.
- **AC-10** (FR-8, NFR-1): Given o áudio tocando, When a pessoa volta para a conversa e faz uma busca, Then o áudio continua, o mini-player aparece com o título e o tempo avançando, e o link do título volta ao player na mesma posição.
- **AC-11** (FR-8): Given o mini-player, When a pessoa clica "Fechar o player", Then o áudio para, a posição é salva e o mini-player some.
- **AC-12** (BR-3): Given qualquer mídia, When a página do player abre (com ou sem posição salva), Then nenhum som toca até um gesto.
- **AC-13** (FR-9): Given um navegador em que o volume é só leitura (WebKit simulado), When abre o player, Then não há controle de volume; no Chrome do desktop há mudo e volume com `aria-valuetext` em porcentagem.
- **AC-15** (FR-10): Given um leitor de tela, When a pessoa aperta L três vezes seguidas, Then a região de status anuncia uma vez a posição final, e nada é anunciado enquanto a barra de progresso está focada e o tempo corre.
- **AC-16** (FR-11): Given o mini-player aberto, When a pessoa navega com Tab até o último resultado da busca, Then o elemento focado fica inteiramente visível acima do mini-player.
- **AC-14** (acessibilidade): Given só o teclado, When a pessoa usa todos os controles e abre "Atalhos de teclado", Then tudo funciona, o diálogo fecha com Esc devolvendo o foco, e não há violações sérias ou críticas do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-5 | integração (API) + E2E | Dois contextos de navegador com a mesma conta para AC-1 e AC-3 |
| AC-3, AC-4 | unitário (serviço de posição com relógio falso) + E2E | Áudio de teste de 20 s; 95% testado com `currentTime` ajustado |
| AC-6, AC-7, AC-8 | unitário (mapa de atalhos) + componente + E2E | Cada atalho com o foco em: corpo, barra, campo de texto, diálogo |
| AC-9 | unitário (adaptador da Media Session com objeto falso) + E2E | O E2E chama os manipuladores registrados pelo `page.evaluate` |
| AC-10, AC-11, NFR-1 | E2E | Amostra `currentTime` a cada 50 ms durante a navegação |
| AC-12 | E2E | `paused === true` após a carga em todos os caminhos de abertura |
| AC-13 | unitário (detecção com elemento falso) + E2E | Chrome e WebKit |
| AC-15 | unitário (anunciador com relógio falso) + E2E | Lê o texto da região de status |
| AC-16 | E2E | Compara o retângulo do foco com o do mini-player a cada Tab, em 1440 e 390 px |
| AC-14 | E2E | axe nos três temas |
| NFR-2 | E2E | Conta as requisições `PUT /progress` em 35 s de reprodução |
| NFR-3 | componente | Conta elementos e ouvintes depois de 20 trocas |
| NFR-4 | E2E | INP pela Performance API |

## References
Tela: `docs/design/screens.md` T15 · Benchmark: [`docs/research/2026-10-28-player-benchmark.md`](../research/2026-10-28-player-benchmark.md) · ADR: [0022](../adr/0022-media-library-store-queue-and-streaming.md) (stream e banco da mídia: posições e preferências ficam no `media.db`) · Barra de qualidade da fase 2: `docs/backlog/README.md`

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled (KBC-034); no open questions
- [x] Fits one goal
