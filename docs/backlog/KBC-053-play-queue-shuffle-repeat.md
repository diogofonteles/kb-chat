---
id: KBC-053
title: "Fila \"A seguir\": tocar a seguir, adicionar à fila, anterior e próxima, aleatório, repetir e continuar com a próxima da lista"
status: ready
slice: phase-2-library
outcome: quem estuda monta uma sessão de estudo (várias palestras em sequência) e ouve sem voltar à tela a cada fim de mídia, no app e pela tela de bloqueio
depends_on: [KBC-051]
---

# KBC-053 — Fila, aleatório, repetir e reprodução contínua

## Story
Como quem estuda, quero enfileirar palestras, pular para a próxima ou voltar à anterior e deixar a lista seguir sozinha, para ouvir uma sessão inteira (por exemplo, no carro) sem mexer no aparelho a cada fim.

## Scope
**In:** **contexto** de reprodução (a lista de onde a pessoa tocou: Biblioteca filtrada, Favoritas, playlist, página do autor); **Tocar a seguir** e **Adicionar à fila** no menu ⋯ de qualquer mídia; painel **A seguir** (tocando agora, "Na fila", "A seguir de: <lista>") com reordenar (arrastar e teclado), remover e **Limpar fila**; ⏮ **Anterior** e ⏭ **Próxima** no player e no mini-player; `nexttrack`/`previoustrack` na Media Session; **Aleatório**; **Repetir** (desligado → lista → esta mídia); **Continuar com a próxima da lista** (ligado por padrão); áudio e vídeo misturados na mesma fila.
**Out:** recomendações ao fim da lista (o "autoplay" de músicas parecidas do Spotify); fila compartilhada entre pessoas (Jam); fila sincronizada entre aparelhos; playlists (KBC-054).

## Business rules
- BR-1: regra do dono (2026-10-28): a fila, o anterior/próxima, o aleatório, o repetir e a reprodução contínua são liberados pela permissão nova `media-queue` ("Fila e reprodução contínua"), que exige `media-library`; masters têm todas; convites e perfis não a concedem por padrão. Sem ela, o player toca uma mídia por vez, como hoje.
- BR-2: ordem do que toca depois da mídia atual: primeiro os itens **Na fila** (na ordem da pessoa), depois os itens restantes do **contexto** (na ordem da lista, ou embaralhados com Aleatório).
- BR-3: **Tocar a seguir** põe a mídia no início de "Na fila"; **Adicionar à fila** põe no fim. Uma mídia pode estar na fila mais de uma vez. A fila tem no máximo 500 itens; o 501º é recusado com "A fila chegou a 500 mídias."
- BR-4: cada mídia que começa pela fila ou pelo contexto parte da **posição salva** da pessoa (KBC-041), ou do início se já foi ouvida ou não tem posição; nunca de um `?t=` antigo.
- BR-5: ⏭ **Próxima** vai para o próximo item da BR-2; ⏮ **Anterior** volta para o item tocado antes nesta sessão (a posição dele é a salva). Com nada antes ou depois, o botão fica desabilitado com a explicação no nome acessível.
- BR-6: **Aleatório** embaralha só os itens do contexto que ainda não tocaram, cada um uma vez antes de qualquer repetição; desligar volta à ordem da lista a partir da mídia atual. "Na fila" nunca é embaralhada.
- BR-7: **Repetir**: "lista" recomeça o contexto ao fim; "esta mídia" recomeça a atual do 0:00 ao terminar (e não a marca como ouvida de novo). Repetir "esta mídia" vence a reprodução contínua.
- BR-8: **Continuar com a próxima da lista** (preferência da conta, ligada por padrão): ao terminar uma mídia, começa a próxima; desligada, para e mostra "A seguir: <título>" com **Tocar**. O timer "No fim desta mídia" (KBC-046) para a sessão inteira, nunca passa para a próxima.
- BR-9: uma mídia que a pessoa deixou de ver (acesso perdido ou mídia removida) é pulada quando chegar a vez dela, com o aviso "Pulamos '<título>': ela não está mais disponível para você.".
- BR-10: a fila e o contexto ficam **neste aparelho** (sobrevivem a recarregar a página e a fechar o navegador); as posições continuam sincronizadas na conta (KBC-041).
- BR-11: vale igual para áudio e vídeo: passar de um áudio para um vídeo (ou o contrário) não corta o som nem recria o player; fora da página do player, o vídeo segue tocando no mini-player só com o som e a imagem volta ao abrir o player.

## Functional requirements
- FR-1: o web deve ter um serviço de fila (`PlayQueue`) sobre o `MediaEngine` (ADR 0025), puro e testável, que implemente as BR-2 a BR-9 e guarde estado (itens, contexto, índice, histórico da sessão, aleatório, repetir) no IndexedDB a cada mudança. (BR-2 a BR-10)
- FR-2: o menu ⋯ de cada mídia (Biblioteca, Favoritas, busca, player) deve ter **Tocar a seguir** e **Adicionar à fila**, com o aviso "Adicionada à fila." (região de status) e **Desfazer** por 8 s. (BR-3)
- FR-3: tocar uma mídia a partir de uma lista deve definir o contexto como essa lista (até 500 itens a partir da mídia tocada), com o nome mostrado em "A seguir de: <lista>". (BR-2)
- FR-4: o painel **A seguir** (T18) deve listar tocando agora, "Na fila" e o contexto, permitir reordenar "Na fila" por arrastar e por **Mover para cima/baixo** (teclado), remover um item com **Desfazer** e **Limpar fila** com **Desfazer**. (BR-2, BR-3)
- FR-5: o player e o mini-player devem ter ⏮ e ⏭; com o `media-queue`, a Media Session deve registrar `nexttrack` e `previoustrack` só quando houver para onde ir, e removê-los (`null`) quando não houver. (BR-5)
- FR-6: os botões **Aleatório** e **Repetir** devem mostrar o estado em texto e `aria-pressed`/rótulo ("Repetir: lista"), e os atalhos Shift+N (próxima) e Shift+P (anterior) devem seguir as regras de atalho do KBC-041 (BR-5 de lá). (BR-5, BR-6, BR-7)
- FR-7: `GET/PUT /api/v1/media/preferences` deve aceitar `continueNext` (booleano). (BR-8)
- FR-8: ao terminar uma mídia, o web deve gravar a posição/ouvida como hoje (KBC-041) **antes** de começar a próxima, e a próxima deve começar em ≤ 1 s. (BR-4, BR-8)

## Non-functional requirements
- NFR-1: a passagem de uma mídia para a próxima não deixa silêncio > 1 s (medido no E2E entre `ended` e o `playing` seguinte), com o app em primeiro plano; em segundo plano no iPhone e no Android, a próxima começa pela tela de bloqueio (conferido em aparelho real antes da produção).
- NFR-2: 500 itens na fila reordenam e rolam sem travar (INP ≤ 200 ms).
- NFR-3: Stryker ≥ 80% no serviço de fila (lógica pura), com fast-check em sequências de operações (adicionar, mover, remover, próxima, anterior, aleatório) que nunca perdem nem duplicam itens.

## Acceptance criteria
- **AC-1** (FR-3, BR-2, BR-8): Given as Favoritas com A, B e C, When a pessoa toca A e A termina, Then B começa sozinha, e o painel mostra "A seguir de: Favoritas" com C.
- **AC-2** (FR-2, BR-2, BR-3): Given A tocando no contexto [A, B, C], When a pessoa escolhe **Tocar a seguir** em X e **Adicionar à fila** em Y, Then a ordem a seguir é X, Y, B, C.
- **AC-3** (BR-4): Given B com posição salva em 12:00, When B começa pela fila, Then começa em 12:00 (±1 s); Given C já ouvida, Then C começa em 0:00.
- **AC-4** (FR-5, BR-5): Given A tocando depois de Z, When a pessoa clica ⏮, Then Z volta na posição salva; When clica ⏭ duas vezes, Then toca a seguinte à A e depois a outra.
- **AC-5** (BR-5): Given a última mídia do contexto, sem fila e sem repetir, When o player abre, Then ⏭ está desabilitado com o nome "Próxima (não há próxima)" e a Media Session não tem `nexttrack`.
- **AC-6** (BR-6): Given o contexto com 10 mídias e **Aleatório** ligado, When as 10 tocam (simulado), Then cada uma toca uma vez, nenhuma repete, e "Na fila" ficou na ordem da pessoa.
- **AC-7** (BR-7): Given **Repetir: esta mídia**, When a mídia termina, Then recomeça do 0:00 e a próxima não começa.
- **AC-8** (BR-7): Given **Repetir: lista** e a última do contexto terminando, When termina, Then a primeira do contexto começa.
- **AC-9** (BR-8, FR-7): Given **Continuar com a próxima da lista** desligado, When A termina, Then nada toca e aparece "A seguir: B" com **Tocar**; a escolha vale em outro navegador da mesma conta.
- **AC-10** (BR-8): Given o timer "No fim desta mídia" (KBC-046), When A termina, Then a sessão para e B não começa.
- **AC-11** (BR-9): Given B na fila e o acesso ao acervo de B revogado, When chega a vez de B, Then B é pulada com o aviso e C começa.
- **AC-12** (BR-3): Given 500 itens na fila, When a pessoa adiciona outro, Then vê "A fila chegou a 500 mídias." e nada muda.
- **AC-13** (FR-4): Given a fila [X, Y], When a pessoa remove X e clica **Desfazer** em até 8 s, Then X volta para o mesmo lugar; When usa **Mover para baixo** em X com o teclado, Then a ordem vira Y, X e a mudança é anunciada.
- **AC-14** (BR-10): Given uma fila montada, When a pessoa recarrega a página, Then a fila e o contexto continuam, e nada toca até um gesto (KBC-041 BR-3).
- **AC-15** (BR-11): Given um áudio seguido de um vídeo na fila, com a pessoa na Biblioteca, When o áudio termina, Then o som do vídeo segue no mini-player sem recriar o elemento de mídia; When ela abre o player, Then a imagem aparece no mesmo segundo.
- **AC-16** (BR-1): Given uma pessoa sem `media-queue`, When abre o player e o menu ⋯, Then não há ⏮, ⏭, Aleatório, Repetir nem "Adicionar à fila", e uma mídia que termina não puxa outra.
- **AC-17** (acessibilidade): Given só o teclado e um leitor de tela, When a pessoa usa ⏮, ⏭, Aleatório, Repetir e o painel A seguir (reordenar, remover, limpar), Then tudo funciona, o foco não se perde ao remover, e não há violações sérias do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-2, AC-4, AC-5, AC-6, AC-7, AC-8, AC-12, AC-13 | unitário (serviço de fila) + componente | Relógio e elemento de mídia falsos; fast-check (NFR-3) |
| AC-1, AC-3, AC-9, AC-10, AC-11, AC-14 | E2E | Mídias reais de 5 s geradas por ffmpeg; dois contextos para AC-9 |
| AC-15 | E2E | Chrome e WebKit; conta elementos de mídia |
| AC-16 | integração (preferências) + E2E | Conta sem a permissão |
| AC-17 | E2E | axe nos três temas |
| NFR-1 | E2E com medição + aparelho real | Resultado do aparelho no `qa.md` |
| NFR-2 | E2E com medição | 500 itens semeados no IndexedDB |

## References
Tela: `docs/design/screens.md` T18 (painel A seguir) e T15 (⏮ ⏭, Aleatório, Repetir) · ADR: [0025](../adr/0025-own-media-player-for-audio-and-video.md) · KBC-041 (posições, atalhos, Media Session), KBC-046 (timer) · Benchmark: [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md) §1.3

## Decisões assumidas (o dono pode mudar)
- ⏮ volta sempre à mídia anterior (não ao começo da atual, como no Spotify): numa palestra de 2 h, voltar ao 0:00 por engano perde o lugar; ⟲15 e a barra cuidam de voltar dentro da mídia.
- A fila é por aparelho (não sincroniza entre aparelhos), para não criar estado no servidor; a posição de cada mídia continua sincronizada.
- Ao fim da lista, o app para; não toca "parecidas" (não há recomendação no produto).

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
