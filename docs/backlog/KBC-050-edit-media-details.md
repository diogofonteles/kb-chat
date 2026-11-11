---
id: KBC-050
title: "Editar as informações de um áudio: título, autoria e acervo"
status: ready
slice: phase-2-a
outcome: quem enviou (ou um master) corrige o título, a autoria ou o acervo de um áudio em segundos, sem apagar e enviar de novo
depends_on: [KBC-034]
---

# KBC-050 — Editar as informações de um áudio

## Story
Como quem envia conteúdo, quero corrigir o título, a autoria e o acervo de um áudio que já enviei, para não ter de apagá-lo e enviar de novo quando errei uma informação.

## Scope
**In:** "Editar informações" no menu da linha (T14) e na página do áudio (T15); diálogo com título, autoria e acervo, já preenchido; mover para outro acervo que a pessoa pode ver e onde pode enviar; as posições, marcadores e transcrição seguem o áudio.
**Out:** trocar o arquivo de áudio (enviar outro); histórico de edições; editar vários de uma vez. Com o KBC-049, o campo de autoria passa a ser o de autores livres (o diálogo é o mesmo).

## Business rules
- BR-1: pode editar quem enviou o áudio, se ainda tiver a permissão de enviar naquele acervo, e qualquer master.
- BR-2: mover para outro acervo exige poder ver e enviar no acervo de destino; quem perde acesso ao acervo novo deixa de ver o áudio (as mesmas regras do acervo).
- BR-3: o título segue as regras do envio (1 a 200 caracteres, sem só espaços).
- BR-4: editar não muda o arquivo, a duração, as posições de quem ouve, os marcadores nem a transcrição.

## Functional requirements
- FR-1: `PATCH /api/v1/media/{id}` deve aceitar `title`, `authorship` e `topic` (cada um opcional) e devolver o item atualizado; 404 sem acesso; 403 sem direito de editar. (BR-1, BR-2, BR-3)
- FR-2: "Editar informações" deve aparecer só para quem pode editar, no menu ⋯ da linha e na página do áudio, e abrir um diálogo já preenchido; salvar fecha o diálogo, atualiza a lista e a página, e anuncia "Informações salvas".
- FR-3: ao mover de acervo, a lista atual deve tirar o áudio e dizer "<título> foi movido para o acervo <nome>." com um link para lá.
- FR-4: um erro do servidor deve manter o diálogo aberto com o que a pessoa digitou e a mensagem do erro.

## Non-functional requirements
- NFR-1: salvar responde em ≤ 500 ms com 1.000 áudios no acervo, medido no teste de integração.

## Acceptance criteria
- **AC-1** (FR-1, FR-2): Given um áudio que a pessoa enviou, When ela muda o título para "A conselheira do rei" e salva, Then a lista e a página mostram o novo título e o áudio toca do mesmo jeito.
- **AC-2** (FR-3, BR-2): Given um áudio no acervo Hermetismo, When quem enviou o move para "UDV", Then ele some da lista do Hermetismo com o aviso e o link, e aparece na UDV com a posição de quem ouvia preservada.
- **AC-3** (BR-1): Given um áudio enviado por outra pessoa, When um membro sem ser master tenta editar, Then a API recusa (403) e "Editar informações" não aparece para ele.
- **AC-4** (BR-2): Given um acervo de destino que a pessoa não vê, When ela tenta mover para lá, Then a API recusa (404, como um acervo que não existe) e o diálogo nem o oferece.
- **AC-5** (BR-3, FR-4): Given um título vazio, When a pessoa salva, Then o diálogo mostra o erro no campo e nada muda.
- **AC-6** (BR-4): Given marcadores e posição salvos, When o título muda, Then marcadores e posição continuam iguais.
- **AC-7** (acessibilidade): o diálogo funciona só com teclado (foco no primeiro campo, Esc fecha e devolve o foco ao menu), sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-6 | integração + E2E | |
| AC-3, AC-4 | integração | duas contas |
| AC-5 | componente + integração | |
| AC-7 | E2E | axe |

## References
Tela: `docs/design/screens.md` T14 (menu da linha) e T15 · Contrato: `libs/contracts/src/media.ts` (`createMediaRequestSchema`) · ADR 0022

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done; no open questions
- [x] Fits one goal
