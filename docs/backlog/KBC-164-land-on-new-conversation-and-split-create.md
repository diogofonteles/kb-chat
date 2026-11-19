---
id: KBC-164
title: "Entrar sempre numa conversa nova e separar criar conversa de criar acervo"
status: ready
slice: ui-v2-areas
outcome: quem abre o app, entra ou recarrega a página começa numa conversa nova do acervo em uso, e cria uma conversa ou um acervo sem passar por um menu
depends_on: [KBC-125, KBC-126]
---

# KBC-164 — Entrar numa conversa nova; criar conversa e acervo separados

Pedido do dono (2026-11-19): "a página inicial de quem entra no app sempre deveria ser a de uma nova conversa, e aqui acho que deveríamos separar a criação de um novo acervo de uma nova conversa".

Como era: `/` abria o `ChatPage` sem guarda; a Pesquisa com IA reabria a última pesquisa depois de recarregar (`sessionStorage` `kb-chat.open-research`), inclusive depois de sair e entrar de novo na mesma aba; o "+ Criar" da Sua biblioteca era um menu com "Nova conversa" e "Novo acervo"; salvar um acervo novo trocava o acervo em uso e começava uma conversa vazia nele ("Nova conversa em X"); no celular, o "+" do cabeçalho só existia na Pesquisa com IA.

## Story
Como quem estuda, quero sempre chegar a uma conversa nova e ter "Nova conversa" e "Novo acervo" como ações separadas, para começar a perguntar sem ver o que ficou de antes e criar um acervo sem perder a conversa em que estou.

## Scope
**In:** a home de conversa nova ao abrir o app, entrar ou recarregar em `/`; o fim da reabertura da pesquisa depois de recarregar; "+ Nova conversa" como botão próprio no cabeçalho da Sua biblioteca (no lugar do menu "+ Criar") e no cabeçalho do celular nas duas visões; "+" de "Novo acervo" no cabeçalho da seção Acervos (coluna e Menu do celular); criar acervo sem trocar o acervo em uso nem a conversa.
**Out:** lembrar o acervo em uso entre recarregamentos (KBC-157); onde entram envios de documentos (KBC-149) e playlists (KBC-054), além de anotar o novo lugar nesses itens; o Figma (a atualizar pelo dono, ver Notas).

## Business rules
- BR-1: abrir o app, entrar (login) ou recarregar a página em `/` mostra a home de conversa nova do acervo em uso: saudação e caixa de pergunta (em foco no desktop). Nada da conversa anterior aparece; ela continua a um clique em Sua biblioteca › Conversas.
- BR-2: um link direto para uma página (`/midia/<id>`, `/configuracoes/…`, `/biblioteca`, um link compartilhado) continua abrindo essa página, também depois de recarregar. Só `/` e o login em `/` levam à conversa nova.
- BR-3: criar um acervo não começa conversa nova e não troca o acervo em uso. O acervo novo aparece na lista (no topo de "Recentes") e só passa a ser o acervo em uso se a pessoa o escolher.
- BR-4: o "+" de "Novo acervo" só aparece para quem tem "Criar acervos" (`collection-create`); "+ Nova conversa" aparece para todos.
- BR-5: a visão lembrada (Buscar ou Pesquisa com IA, `kb-chat.view`) continua valendo depois de recarregar.

## Functional requirements
- FR-1: "+ Nova conversa" é um botão (sem menu) no cabeçalho da Sua biblioteca, ao lado de "Sua biblioteca" e ⤢; recolhida, a coluna mostra só o "+", com o nome para leitores de tela. No celular, o "+" do cabeçalho existe nas duas visões e começa uma conversa nova na visão da tela (a outra visão guarda a sua). A linha "Nova conversa" do Menu continua. (BR-1)
- FR-2: "Novo acervo" é um "+" no cabeçalho da seção Acervos, na coluna e na parte Acervos do Menu do celular; a linha "Novo acervo" do rodapé do Menu sai. A Biblioteca expandida (⤢) mantém o seu botão "Novo acervo". (BR-3, BR-4)
- FR-3: a pesquisa não grava nem lê mais `kb-chat.open-research`; recarregar não busca a conversa anterior. (BR-1)
- FR-4: sem áudio, o link para "Biblioteca" ou "Mídia" que ficava no menu "+ Criar" fica ao lado do filtro da Sua biblioteca (nenhuma ação da v1 se perde, KBC-125 BR-1).

## Acceptance criteria
- AC-1 (BR-1, BR-5, FR-3): Given uma pesquisa com IA respondida, When a pessoa recarrega a página, Then vê "O que você quer pesquisar no acervo?" sem a resposta, a caixa em foco no desktop, a visão continua Pesquisa com IA, e a conversa abre de novo com um clique em Conversas; Given uma busca na visão Buscar, When recarrega, Then vê "O que você quer estudar hoje?" na visão Buscar.
- AC-2 (BR-1, negativo): Given uma pesquisa respondida, When a pessoa sai e entra de novo na mesma aba, Then vê a home de conversa nova, sem a pesquisa anterior.
- AC-3 (BR-2, borda): Given o link `/midia/<id>`, When a pessoa o abre e recarrega, Then a página da mídia continua aberta, não a home.
- AC-4 (FR-1): Given uma busca na tela, When a pessoa toca "+ Nova conversa" (coluna no desktop; cabeçalho no celular, nas duas visões), Then a home de conversa nova aparece, sem abrir menu; não há botão "Criar".
- AC-5 (FR-2, BR-3): Given uma busca na tela e o acervo Hermetismo em uso, When a pessoa cria "UDV" pelo "+" de Acervos, Then "UDV" aparece na lista sem `aria-current`, Hermetismo continua em uso, os resultados continuam na tela e não aparece "Nova conversa em UDV"; When escolhe "UDV", Then ele passa a ser o acervo em uso.
- AC-6 (BR-4, negativo): Given uma pessoa sem "Criar acervos", Then não há "+" de "Novo acervo" e a API recusa criar (403); "+ Nova conversa" continua.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | unidade (`research-store.spec.ts`: recarregar começa conversa nova, mesmo com a chave antiga na aba) + E2E `new-conversation-home.spec.ts` | 1440 e 390 |
| AC-2 | E2E `new-conversation-home.spec.ts` | sair e entrar pelo botão do Google (falso) |
| AC-3 | E2E `new-conversation-home.spec.ts` | mídia enviada no `beforeAll` |
| AC-4 | componente (`chat-page.spec.ts`: botão próprio, sem menu; "+" do cabeçalho do celular na busca; `research-page.spec.ts`) + E2E `new-conversation-home.spec.ts`, `v2-shell.spec.ts` | 1440 e 390 |
| AC-5 | componente (`chat-page.spec.ts`) + E2E `new-conversation-home.spec.ts`, `collections.spec.ts` | |
| AC-6 | E2E `collections.spec.ts` (AC-4 do KBC-048) | |

## References
Telas: `docs/design/screens.md` T1 · `docs/design/redesign-v2.md` (Casca) · KBC-125 (Sua biblioteca), KBC-126 (home), KBC-029 (histórico), KBC-048 (acervos)

## Notes
- **Figma a atualizar** (regras do dono, 2026-11-19, que valem sobre os frames): o cabeçalho da Sua biblioteca desenha "+ Criar" onde agora fica "+ Nova conversa"; o cabeçalho da seção Acervos ganha o "+" de "Novo acervo"; o Menu do celular perde a linha "Novo acervo" do rodapé (ela vai para o "+" de Acervos); o cabeçalho do celular na visão Buscar ganha o "+". As diferenças estão excusadas em `figma-recreation/inventory/exceptions.json` com "dono, 2026-11-19".
- Premissa: sair (Sair) continua recarregando a mesma página; depois de entrar de novo num endereço que não é `/`, ele abre como um link direto (BR-2).
- KBC-149 e KBC-054 planejavam entrar pelo "+ Criar": agora entram onde cabem (envios nas ações da biblioteca, playlists na biblioteca).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable (sem NFR novo: KBC-048 NFR-1, ≤ 2 s até o acervo aparecer, continua)
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
