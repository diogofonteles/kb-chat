---
id: KBC-073
title: "Editar faixas depois de aprovadas: título, descrição, quem fala, assuntos e início e fim, sem quebrar posições, marcadores, playlists, busca e cópias offline; apagar com arquivo e restauração"
status: ready
slice: phase-2-editing
outcome: corrigir uma faixa já aplicada leva ≤ 1 minuto, sem refazer a edição inteira, e nenhuma posição, marcador, playlist, favorito ou cópia offline de quem ouve se perde ou aponta para o trecho errado
depends_on: [KBC-068, KBC-069, KBC-042, KBC-056]
---

# KBC-073 — Editar faixas depois de aprovadas

## Story
Como quem edita, quero corrigir uma faixa já aplicada (o título, a descrição, quem pergunta e quem responde, os assuntos, onde ela começa e termina) direto na página dela, sem refazer a edição da gravação, para manter o acervo certo à medida que acho erros, sem estragar o que quem ouve já guardou.

## Análise de viabilidade

O que já depende de uma faixa aplicada (ADR 0029, KBC-068): o identificador da faixa (favoritos, playlists, fila, compartilhamentos, links `?t=`), a posição de quem ouve e os marcadores (KBC-041, KBC-042, em ms dentro da faixa), o arquivo cortado da gravação completa sem recodificar e as cópias offline com `ETag` (KBC-056), a transcrição, as legendas e as palavras derivadas da gravação completa, o índice da busca (ADR 0024) e os assuntos (KBC-069). A gravação completa continua guardada ao lado (decisão do dono, 2026-11-03), então todo recorte pode ser refeito a partir dela.

| Edição | Viável agora? | O que precisa atualizar | Custo e risco | Quem pode |
|---|---|---|---|---|
| Título | Sim | o item, os resultados da busca (o título entra na busca de faixas, KBC-070), metadados das cópias offline no próximo contato | quase zero; baixo | `media-edit` |
| Descrição (resumo) | Sim | o item, a busca por resumo (KBC-070) | quase zero; baixo | `media-edit` |
| Quem pergunta e quem responde | Sim, com regras | o item; o autor da faixa quando quem responde é autor do acervo (filtro de autoria e página do autor, KBC-059); a legenda e a transcrição mostram o nome novo; escolha "só nesta faixa" ou "em toda a gravação" (o nome da voz na gravação completa, KBC-065) | baixo; médio se trocar em toda a gravação (muda várias faixas de uma vez) | `media-edit` |
| Assuntos | Sim (já é o KBC-069) | ligações e contagens da busca | baixo | `media-classify` |
| Início e fim | Sim, com regras | recortar de novo da gravação completa (cópia de fluxo, segundos); a mesma identidade da faixa; nova versão do arquivo (`ETag`); transcrição, legendas e palavras derivadas de novo; índice da busca; posições e marcadores remapeados pelo tempo absoluto na gravação; cópias offline marcadas como desatualizadas; vizinhas sem sobreposição e mínimo de 5 s | CPU baixa (segundos no worker); risco médio (remapeamento) | `media-edit` |
| Apagar uma faixa | Sim, com confirmação | arquivar (some da Biblioteca e da busca), playlists e favoritos mostram "Faixa removida da edição", cópias offline param no próximo contato; o trecho continua na gravação completa; restaurar em até 30 dias | baixo; médio para quem tinha a faixa guardada (por isso a confirmação mostra o impacto) | `media-edit` |
| Refazer a IA numa faixa | Sim, com regras | só sugestões de título, quem fala e assuntos para aquela faixa, aceitas pela pessoa; custo no limite mensal da mídia | ≈ US$ 0,001 por faixa; baixo | `media-edit-ai` |
| Juntar duas faixas | Depois | uma identidade sobrevive, a outra é arquivada; posições, marcadores, playlists e favoritos da arquivada precisam ir para a sobrevivente; playlists com as duas ficam com item repetido | risco alto (mexe no que outras pessoas guardaram) | — |
| Dividir uma faixa | Depois | a identidade fica com uma parte e a outra nasce nova; quem guardou a faixa não recebe a parte nova sozinho | risco alto | — |

Juntar e dividir continuam possíveis reabrindo a edição da gravação (KBC-066 passo 3, com as regras de reaprovação do KBC-068); fora dela, ficam para um item próprio.

## Scope
**In:** na página da faixa e no menu ⋯ da Biblioteca (para quem pode): editar título, descrição, quem pergunta e quem responde (com "só nesta faixa" ou "em toda a gravação"), assuntos; "Ajustar início e fim" num editor de uma faixa só, com a mesma barra, alças, encaixe, ajuste fino, "Ouvir o início/o fim" e limites do KBC-066 (as vizinhas aparecem e limitam); "Apagar faixa" com confirmação que mostra o impacto e "Faixas apagadas" para restaurar em 30 dias; "Sugerir de novo com IA" para uma faixa; histórico de alterações por faixa (quem, quando, o quê, antes e depois).
**Out:** juntar e dividir fora da edição da gravação (item futuro); editar o texto da transcrição; trocar a gravação completa; vídeo.

## Business rules
- BR-1: a identidade de uma faixa (o seu id) nunca muda por edição: título, descrição, falantes, assuntos e limites mudam o mesmo item; favoritos, playlists, fila, compartilhamentos e links continuam apontando para ele.
- BR-2: a gravação completa não pode ser apagada enquanto tiver faixas não arquivadas; "Remover" da gravação (KBC-034) passa a exigir apagar as faixas antes, ou apaga tudo junto numa confirmação que lista as faixas.
- BR-3: mudar o início ou o fim recorta de novo a partir da gravação completa, sem recodificar, troca o arquivo de forma atômica (o antigo serve até o novo estar pronto) e gera uma versão nova (`ETag`); a faixa continua tocável durante o recorte.
- BR-4: posições e marcadores são remapeados pelo tempo absoluto na gravação: `absoluto = início antigo + posição`; `posição nova = absoluto − início novo`. Uma posição que cai fora da faixa nova vai para 0 (antes do início) ou é marcada como ouvida até o fim (depois do fim). Um marcador que cai fora passa para a gravação completa, no mesmo tempo absoluto, e o dono do marcador vê "1 marcador foi movido para a gravação completa porque a faixa mudou".
- BR-5: as regras de limites do KBC-066 valem aqui: vizinhas nunca se sobrepõem, mínimo de 5 s, encaixe em palavra ou silêncio, ajuste fino de ±0,5 s.
- BR-6: uma cópia offline de uma versão antiga continua tocando sem rede; no próximo contato, a pessoa vê "Esta faixa mudou" e a cópia é trocada pela nova (as regras de `ETag` do KBC-056); nunca toca misturada.
- BR-7: apagar arquiva: a faixa some da Biblioteca, da busca e das filas; playlists e favoritos mostram "Faixa removida da edição"; restaurar em até 30 dias devolve tudo como era (posições e marcadores incluídos); depois de 30 dias o arquivo cortado é apagado, mas o registro fica para as playlists dizerem o que era.
- BR-8: cada mudança fica no histórico da faixa (quem, quando, campo, antes, depois); só masters veem o histórico de todas as faixas, quem edita vê o das faixas que pode editar.
- BR-9: "Sugerir de novo com IA" só propõe; nada muda até a pessoa aceitar; o custo segue o KBC-067 BR-3.
- BR-10: duas pessoas editando a mesma faixa: a segunda a salvar recebe 412 e vê a mudança da outra, sem perder a sua.

## Functional requirements
- FR-1: `PATCH /api/v1/media/{trackId}` deve aceitar `title`, `summary`, `askerSpeakerId`, `answererSpeakerId` com `scope: track|recording`, e devolver o item com a versão nova; com `scope: recording`, muda o nome da voz na gravação completa e em todas as faixas dela. (BR-1, BR-10)
- FR-2: `PUT /api/v1/media/{trackId}/bounds` deve validar (BR-5), criar o trabalho de recorte, e, quando o arquivo novo estiver pronto, numa transação: trocar o arquivo, gravar os tempos reais, derivar transcrição, legendas e palavras, reindexar, remapear posições e marcadores (BR-4) e subir o `ETag`. (BR-3, BR-4)
- FR-3: `DELETE /api/v1/media/{trackId}` deve arquivar, e `POST /api/v1/media/{trackId}/restore` restaurar em até 30 dias; `GET /api/v1/media/{recordingId}/archived-tracks` lista as apagadas. (BR-7)
- FR-4: Antes de apagar, a tela deve mostrar o impacto: "3 pessoas têm esta faixa em playlists, 5 nos favoritos e 1 cópia offline. Você pode restaurar em até 30 dias." com **Apagar faixa** (perigo) e **Cancelar**. (BR-7)
- FR-5: `GET /api/v1/media/{trackId}/history` deve devolver as mudanças. (BR-8)
- FR-6: "Ajustar início e fim" deve abrir o editor de uma faixa (o componente da barra do KBC-066) com as vizinhas visíveis e limitando, e **Salvar limites** mostra "Recortando… pronto" sem interromper quem está ouvindo. (BR-3, BR-5)
- FR-7: `POST /api/v1/media/{trackId}/suggestions` deve rodar a IA só para a faixa, com estimativa antes, e devolver sugestões a aceitar. (BR-9)
- FR-8: `DELETE` da gravação completa com faixas não arquivadas deve responder 409 com a lista das faixas, salvo com `cascade=true` vindo da confirmação. (BR-2)

## Non-functional requirements
- NFR-1: salvar título, descrição ou falantes responde em ≤ 300 ms; a busca mostra o título novo na próxima consulta.
- NFR-2: ajustar os limites de uma faixa de 10 min fica pronto (arquivo, transcrição, índice, remapeamento) em ≤ 15 s no worker com 1 CPU, medido no teste de integração com ffmpeg real.
- NFR-3: o remapeamento é exato: zero posições ou marcadores fora do lugar em 10.000 casos gerados (fast-check).

## Acceptance criteria
- **AC-1** (FR-1, BR-1): Given uma faixa favoritada e numa playlist, When quem edita muda o título, Then o favorito e a playlist mostram o título novo e a busca o acha na consulta seguinte.
- **AC-2** (FR-1, escopo): Given a Voz 2 nomeada "Pergunta da plateia" em 8 faixas, When quem edita escolhe "José" "em toda a gravação" numa delas, Then as 8 faixas e a transcrição mostram "José"; When escolhe "só nesta faixa", Then só ela muda.
- **AC-3** (FR-1): Given uma faixa cujo respondente vira um autor do acervo, When salvo, Then o autor da faixa muda e ela aparece na página desse autor (KBC-059).
- **AC-4** (FR-2, BR-3, BR-4): Given uma faixa de 12:00 a 16:00 ouvida por uma pessoa até 1:30 (13:30 absoluto) e um marcador em 3:50 (15:50 absoluto), When o início vai para 12:30 e o fim para 15:30, Then a posição vira 1:00, o marcador sai da faixa para a gravação completa em 15:50 com o aviso ao dono dele, e o arquivo, a legenda e a transcrição começam em 12:30.
- **AC-5** (BR-1, BR-3): Given a mesma faixa numa playlist e alguém ouvindo durante o recorte, When o recorte termina, Then a playlist aponta para o mesmo id, a reprodução não para e a próxima abertura usa o arquivo novo.
- **AC-6** (BR-5, negativo): Given a faixa 4 encostada na faixa 5, When quem edita tenta passar o fim da 4 para dentro da 5, Then a alça para em "Encostou na faixa 5"; Given um `PUT …/bounds` direto que sobrepõe ou deixa < 5 s, Then 422.
- **AC-7** (BR-6): Given uma cópia offline da versão antiga, When o aparelho fica sem rede, Then a cópia antiga toca inteira; When a rede volta, Then aparece "Esta faixa mudou" e a cópia é trocada pela nova, sem tocar misturada.
- **AC-8** (FR-3, FR-4, BR-7): Given uma faixa em 3 playlists, When quem edita apaga, Then a confirmação mostra o impacto, a faixa some da Biblioteca e da busca e as playlists mostram "Faixa removida da edição"; When restaura em 10 dias, Then tudo volta, posições e marcadores incluídos.
- **AC-9** (BR-7, limite): Given uma faixa apagada há 31 dias, When alguém tenta restaurar, Then a API recusa e a playlist continua com "Faixa removida da edição".
- **AC-10** (FR-8, BR-2): Given uma gravação com 12 faixas ativas, When um master aciona "Remover" nela, Then a confirmação lista as 12 faixas; sem confirmar a cascata, a API responde 409.
- **AC-11** (FR-7, BR-9): Given uma faixa, When quem tem `media-edit-ai` pede "Sugerir de novo com IA" e não aceita nada, Then a faixa fica igual e o custo aparece no limite mensal.
- **AC-12** (FR-5, BR-8): Given 3 mudanças numa faixa, When quem edita abre o histórico, Then vê quem, quando, o campo, antes e depois.
- **AC-13** (BR-10): Given duas pessoas editando o título da mesma faixa, When a segunda salva, Then recebe a mensagem de conflito com o título da outra e o seu continua copiável.
- **AC-14** (permissão): Given quem tem `media` sem `media-edit`, When abre a faixa, Then não vê "Editar", "Ajustar início e fim" nem "Apagar faixa", e as rotas respondem 403; Given `media-edit` sem `media-classify`, Then não edita assuntos.
- **AC-15** (acessibilidade): edições na página da faixa e o editor de uma faixa funcionam só com teclado (as alças com as teclas do KBC-066), sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-3, AC-12, AC-13 | integração + E2E | |
| AC-4, NFR-3 | unitário do remapeamento (fast-check) + integração com ffmpeg real | |
| AC-5, AC-7 | E2E no Google Chrome e no WebKit (offline por `context.setOffline`) | `ETag` trocado |
| AC-6, AC-9, AC-10, AC-14 | integração | |
| AC-8, AC-11 | integração + E2E | LLM stub |
| AC-15 | E2E | axe |
| NFR-2 | integração | worker com CPU limitada |

## References
ADR [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md), 0024, 0026 · KBC-041, KBC-042 (posições e marcadores), KBC-052 a KBC-057 (favoritos, playlists, offline), KBC-059 (autor), KBC-065, KBC-066 (barra e alças), KBC-068 (itens derivados), KBC-069 (assuntos) · Tela T15 (página da faixa) · Pedido do dono (2026-11-03): "essas funções de edição podem ser ajustadas novamente mesmo depois de finalizada a edição do áudio e divisão em faixas, como alterar o nome da faixa, nome de quem fala, onde começa e termina a faixa e etc"

## Decisões assumidas (o dono pode mudar)
- Juntar e dividir faixas fora da edição da gravação ficam para depois (risco alto para quem já guardou as faixas); continuam possíveis reabrindo a edição inteira.
- Editar depois de aprovado usa as permissões que já existem (`media-edit`, `media-classify`, `media-edit-ai`), sem uma permissão nova, porque é a mesma capacidade de editar.
- Faixas apagadas podem ser restauradas por 30 dias.

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
