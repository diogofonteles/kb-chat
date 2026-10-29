---
id: KBC-058
title: "Compartilhar playlists com pessoas do app: \"pode ouvir\" ou \"pode editar\", sem link público, cada pessoa só vê as mídias dos acervos que já vê"
status: ready
slice: phase-2-library
outcome: quem orienta um grupo de estudo monta o percurso uma vez e os colegas o ouvem (e ajudam a montar) na própria Biblioteca
depends_on: [KBC-054]
---

# KBC-058 — Compartilhar playlists com pessoas do app

## Story
Como quem orienta um grupo de estudo, quero compartilhar uma playlist com colegas que usam o app, deixando alguns só ouvirem e outros editarem, para estudarmos o mesmo percurso sem que a mídia saia do app.

## Scope
**In:** **Compartilhar** no ⋯ da playlist (só quem a criou); convidar pessoas do app pelo e-mail, com o papel **Pode ouvir** ou **Pode editar**; lista de quem tem acesso, mudar o papel e **Remover acesso**; seção **Compartilhadas comigo** na Biblioteca, com o nome de quem compartilhou; **Sair da playlist** para quem recebeu; quem edita adiciona, remove e reordena (KBC-054) e a lista mostra quem adicionou cada mídia; o estado de escuta e a fila de cada pessoa continuam dela; selo "Compartilhada" na playlist.
**Out:** link público ou por convite aberto (o Spotify usa link de 7 dias; aqui a mídia é só entre usuários do app); compartilhar pastas, Favoritas ou marcadores (fase D); comentários; notificação por e-mail; compartilhar com grupo (entra quando o KBC-047 sair de rascunho).

## Business rules
- BR-1: regra do dono (2026-10-28): compartilhar exige a permissão nova `media-playlist-sharing` ("Compartilhar playlists"), além de `media-playlists`; masters têm todas; convites e perfis não a concedem por padrão. Receber exige `media-library`; editar uma playlist recebida exige também `media-playlists`.
- BR-2: só quem criou a playlist compartilha, muda papéis, remove acesso, renomeia e apaga; quem tem **Pode editar** só mexe nos itens; quem tem **Pode ouvir** só ouve.
- BR-3: cada pessoa vê, na playlist compartilhada, só as mídias dos acervos que ela já vê; as outras ficam ocultas para ela, com "N mídias ocultas: você não tem acesso a elas." Compartilhar nunca dá acesso a acervo.
- BR-4: quem edita só pode adicionar mídias que ela mesma vê; a ordem e os itens são os mesmos para todos (respeitando a BR-3 na exibição).
- BR-5: o convite pelo e-mail responde sempre igual, exista ou não a pessoa: "Se esse e-mail for de alguém que usa o app com a Biblioteca, a playlist aparece para essa pessoa." O app nunca revela a quem não é master quem usa o app.
- BR-6: até 50 pessoas por playlist; o 51º convite é recusado com "Uma playlist pode ser compartilhada com até 50 pessoas.".
- BR-7: remover o acesso, a pessoa sair, perder `media-library` ou a playlist ser apagada tira a playlist da Biblioteca dela no próximo carregamento; as posições e marcadores dela nas mídias continuam dela.
- BR-8: vale igual para áudio e vídeo.

## Functional requirements
- FR-1: `POST /api/v1/media/playlists/{id}/members` (`email`, `role`) deve aplicar BR-1, BR-2, BR-5 e BR-6 e responder 202 com a mensagem da BR-5 em todos os casos de e-mail válido; `GET …/members` (só quem criou) deve listar as pessoas com papel; `PATCH/DELETE …/members/{principal}` devem mudar o papel e remover; `DELETE …/members/me` deve fazer a pessoa sair. (BR-1, BR-2, BR-5, BR-6, BR-7)
- FR-2: `GET /api/v1/media/playlists?shared=with-me` deve listar as playlists recebidas com o nome de quem compartilhou e o papel; `GET /media/playlists/{id}` deve aplicar a BR-3 por pessoa e trazer `addedBy` por item. (BR-3)
- FR-3: as rotas de itens e ordem (KBC-054 FR-2 e FR-3) devem aceitar quem tem **Pode editar** e recusar (403) quem tem **Pode ouvir**; a `version` continua resolvendo edições simultâneas. (BR-2, BR-4)
- FR-4: a tela **Compartilhar** (diálogo, T17) deve ter o campo de e-mail com rótulo, a escolha do papel (rádios, **Pode ouvir** pré-marcado), a lista de pessoas com papel e **Remover acesso** (com **Desfazer** por 8 s), e a nota "As pessoas só ouvem as mídias dos acervos que já podem ver.". (BR-3)
- FR-5: a Biblioteca deve ter a seção **Compartilhadas comigo** e a playlist recebida deve mostrar "De <nome>" e o papel, sem as ações de quem criou. (BR-2)

## Non-functional requirements
- NFR-1: a resposta do convite leva o mesmo tempo (± 50 ms, p95) exista ou não o e-mail, para não revelar usuários pelo tempo (teste de integração com 100 chamadas de cada).
- NFR-2: uma playlist com 50 pessoas e 1.000 itens abre para qualquer uma em ≤ 1 s.

## Acceptance criteria
- **AC-1** (FR-1, FR-5): Given a playlist "Curso" de A, When A a compartilha com o e-mail de B (**Pode ouvir**), Then B vê "Curso" em **Compartilhadas comigo** com "De A", e pode tocar, mas não vê editar, renomear nem apagar.
- **AC-2** (BR-3): Given "Curso" com uma mídia do acervo UDV que B não vê, When B abre a playlist, Then a mídia não aparece e há "1 mídia oculta: você não tem acesso a ela."; e B continua sem acesso à UDV em qualquer outra tela.
- **AC-3** (FR-3, BR-2): Given B com **Pode ouvir**, When B chama `POST …/items`, Then recebe 403; Given C com **Pode editar**, When C adiciona uma mídia que vê, Then ela aparece para A com "Adicionada por C".
- **AC-4** (BR-4): Given C com **Pode editar**, When C tenta adicionar uma mídia de um acervo que não vê, Then a API responde 404 e nada muda.
- **AC-5** (BR-5, NFR-1): Given um e-mail que não é de ninguém no app, When A o convida, Then vê a mesma mensagem de um e-mail válido, e nada é criado.
- **AC-6** (BR-7, FR-1): Given B na playlist, When A clica **Remover acesso** em B, Then a playlist some da Biblioteca de B no próximo carregamento; When A clica **Desfazer** em até 8 s, Then B continua com o mesmo papel.
- **AC-7** (BR-7): Given B na playlist, When B escolhe **Sair da playlist**, Then ela some para B e continua para A.
- **AC-8** (BR-2): Given C com **Pode editar**, When C chama `PATCH` para renomear ou `DELETE` na playlist, Then recebe 403.
- **AC-9** (BR-6): Given 50 pessoas, When A convida a 51ª, Then vê a mensagem do limite.
- **AC-10** (BR-1): Given A sem `media-playlist-sharing`, When abre o ⋯ da playlist, Then não há **Compartilhar**, e `POST …/members` responde 403; Given B sem `media-library`, Then nada aparece para B.
- **AC-11** (BR-7): Given A apaga "Curso", When B abre a Biblioteca, Then "Curso" não aparece; as posições de B nas mídias continuam.
- **AC-12** (acessibilidade): Given só o teclado e um leitor de tela, When A compartilha, muda o papel e remove alguém, Then tudo funciona, o foco vai para a lista depois de convidar e volta ao campo depois de remover, e não há violações sérias do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-6, AC-7 | integração + E2E | Três contas (A, B, C) |
| AC-2, AC-3, AC-4, AC-8, AC-9, AC-10, AC-11 | integração (API) | Acervos diferentes por conta |
| AC-5, NFR-1 | integração com medição | 100 chamadas de cada tipo |
| AC-12 | E2E | axe |
| NFR-2 | integração + E2E com medição | Dados semeados |

## References
KBC-054 (playlists e `version`), KBC-047 (grupos, rascunho), KBC-010 e ADR [0008](../adr/0008-google-login-and-permissions.md) (acesso por acervo) · Tela: `docs/design/screens.md` T17 (Compartilhar) e T16 (Compartilhadas comigo) · Benchmark: [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md) §1.2 · Plano da fase 2: compartilhamento é da fase D; este item antecipa só playlists.

## Decisões assumidas (o dono pode mudar)
- Convite pelo e-mail, sem lista de pessoas para quem não é master, e com a mesma resposta exista ou não a pessoa (privacidade dos convidados).
- Sem notificação por e-mail: a playlist aparece em **Compartilhadas comigo** com o selo "Nova" até ser aberta.
- **Pode ouvir** é o papel pré-marcado.

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
