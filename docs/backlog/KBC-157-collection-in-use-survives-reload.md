---
id: KBC-157
title: "O acervo em uso sobrevive a recarregar a página"
status: ready
slice: ui-v2-areas
outcome: recarregar a página (F5, nova aba, voltar ao app) abre no acervo que a pessoa estava usando em 100% dos casos em que ele ainda existe e está acessível
depends_on: [KBC-125]
---

# KBC-157 — O acervo em uso sobrevive a recarregar a página

Pedido do dono (2026-11-17): o acervo escolhido na barra lateral "Acervos" volta ao padrão quando a página é recarregada.

Causa: `ChatStore.topicSlug` (`apps/web/src/app/features/chat/chat-store.ts`, `linkedSignal` sobre a lista de acervos) só guarda a escolha enquanto a aba vive; ao recarregar cai em `pickDefaultTopic` (`defaultSlug` do servidor, senão o maior acervo). Já existe `preferences.defaultTopic` (`libs/contracts/src/settings.ts`), mas é o acervo **padrão** escolhido em Configurações, outra coisa: não é o "em uso", e gravá-lo a cada clique mudaria o padrão da pessoa. Não há endpoint de preferência de "último acervo".

## Story
Como estudante, quero que o acervo em que eu estava continue o mesmo depois de recarregar, para não escolher de novo toda vez.

## Scope
**In:** lembrar o slug do acervo em uso por pessoa e por navegador (`localStorage`, como `mode-preference.ts` e `kinds-preference` do mesmo store); aplicá-lo quando a lista de acervos chega.
**Out:** sincronizar entre dispositivos (decisão: sem endpoint novo; o padrão entre dispositivos continua sendo `defaultTopic`); lembrar a conversa aberta; mudar o padrão de Configurações.

## Business rules
- BR-1: a chave inclui a pessoa (e-mail ou id da sessão): em um navegador compartilhado, uma pessoa nunca recebe o acervo da outra.
- BR-2: ordem de decisão ao carregar a lista: acervo lembrado (se existe e `canOpen`) > `defaultTopic`/`defaultSlug` > maior acervo (`pickDefaultTopic`).
- BR-3: trocar de acervo grava; uma troca que a pessoa não fez (queda para o padrão) não grava por cima do lembrado até ela escolher.
- BR-4: `localStorage` indisponível (janela privada, bloqueado) não quebra: o app roda como hoje.

## Functional requirements
- FR-1: ao escolher um acervo (sidebar, conversa aberta, atalhos), gravar o slug em `kb-chat.topic.<pessoa>`. (BR-1, BR-3)
- FR-2: ao chegar a lista, `topicSlug` usa o lembrado por BR-2; sem lembrado, comporta-se como hoje. (BR-2)
- FR-3: abrir uma conversa de outro acervo continua trocando o acervo (já faz) e passa a gravar. (BR-3)
- FR-4: leitura e escrita dentro de `try/catch`. (BR-4)

## Acceptance criteria
- AC-1 (FR-1, FR-2): Given que escolhi o acervo B, When recarrego, Then B está selecionado depois da lista chegar (sem piscar o padrão como acervo ativo).
- AC-2 (BR-2, negativo): Given que o acervo B foi removido, When recarrego, Then cai no padrão (`defaultTopic`, senão o maior) sem erro e sem aviso de falha.
- AC-3 (BR-2, BR-3, negativo): Given que perdi o acesso a B (`canOpen` falso ou fora da lista), When recarrego, Then cai no padrão sem erro; e o lembrado não é apagado: se o acesso voltar e eu recarregar, B volta a ser usado.
- AC-4 (BR-1): Given duas pessoas no mesmo navegador, When a segunda entra, Then vê o seu acervo, não o da primeira.
- AC-5 (BR-4, edge): Given `localStorage` que lança erro, When abro o app, Then funciona com o padrão e a troca de acervo continua valendo na sessão.
- AC-6 (FR-3): Given que abro uma conversa do acervo C, When recarrego, Then C está em uso.
- AC-7 (UI, 1440 e 390, Chromium e WebKit): Given a escolha de um acervo, When recarrego, Then o item marcado na barra lateral (1440) e na folha de acervos (390) é o escolhido.

## Test strategy
- AC-1..AC-6: unidade do `ChatStore` (`chat-store.spec.ts`) com storage fake e com storage que lança.
- AC-7: E2E em `e2e` (fixture vault com dois acervos) em 1440 e 390, Chromium e WebKit.

## UI references
Sem tela nova. Figma `au1MI6z2Vwy9tnqOv2vrfH`, quadros da casca v2 (barra lateral "Acervos" e folha no celular): nenhum frame novo; conferir que o estado "selecionado" existe nos dois tamanhos e, se faltar, adicionar o frame.

## References
`apps/web/src/app/features/chat/chat-store.ts` (`topicSlug`, `pickDefaultTopic`, `safeStorage`) · `apps/web/src/app/features/chat/mode-preference.ts` (o padrão a seguir) · `apps/web/src/app/features/sidebar/sidebar.ts` · `libs/contracts/src/settings.ts` (`defaultTopic`)

## Decisões assumidas (o dono pode mudar)
- `localStorage` por pessoa e por dispositivo, em vez de um endpoint de preferência (não existe um para isso; `defaultTopic` é outra coisa).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done; no open questions
- [x] Fits one goal
