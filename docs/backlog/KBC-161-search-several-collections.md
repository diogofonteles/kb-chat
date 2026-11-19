---
id: KBC-161
title: "Buscar e pesquisar em vários acervos de uma vez, por escolha explícita"
status: draft
slice: ui-v2-areas
outcome: quem liga "vários acervos" e marca N acervos recebe busca, Pesquisa com IA e biblioteca que consideram exatamente esses N (com seus sub-acervos), e nada de fora deles, em 100% das execuções; quem não liga continua num acervo só
depends_on: [KBC-152]
---

# KBC-161 — Buscar e pesquisar em vários acervos de uma vez

Pedido do dono (2026-11-19), ao corrigir a mistura de acervos na biblioteca: "os acervos não deveriam se misturar, quando eu selecionar um acervo, só deveria mostrar-me documentos e áudios relacionados a ele". A correção (KBC-152, branch `fix/v2-collection-scope`) fixou a regra: o acervo em uso é o escopo da busca, da pesquisa e da biblioteca, com os sub-acervos quando é pai (ADR 0028 §6), nunca outro acervo de primeiro nível. Considerar vários acervos ao mesmo tempo é outra coisa: uma função nova que a pessoa liga de propósito, nunca um efeito colateral de um filtro guardado.

Hoje: a conversa tem um `topic` (`ChatStore.topicSlug`); a API resolve o escopo por `Catalog.scope(slug)` (o acervo e os filhos); as ferramentas da pesquisa (`tool-context.ts`, `find_text`, `list_sources`, varredura do perfil exaustivo) só enxergam esse escopo. "Todas as mídias" existe só na biblioteca (endereço `?acervos=todos`) e não vale para busca nem pesquisa.

## Story
Como estudante que estuda dois acervos relacionados (por exemplo Hermetismo e UDV), quero ligar "vários acervos" e escolher quais entram, para buscar e pesquisar em todos eles numa pergunta só, sabendo sempre quais estão valendo.

## Scope
**In:** um modo "vários acervos" que a pessoa liga explicitamente; a escolha de 2 ou mais acervos que ela pode abrir; busca simples, Pesquisa com IA (todos os perfis, incluindo o exaustivo e a varredura) e biblioteca considerando a união desses acervos (cada um com seus sub-acervos); citações e resultados dizendo de qual acervo vêm; a conversa salva lembrando quais acervos valeram.
**Out:** buscar em acervos que a pessoa não pode abrir; mudar as permissões por acervo (KBC-010, ADR 0008); misturar acervos por padrão ou por filtro guardado; reordenar resultados por acervo (a ordem continua por relevância).

## Business rules
- BR-1: desligado é o padrão. Sem ligar o modo, tudo continua num acervo só, o acervo em uso (KBC-152).
- BR-2: ligar é uma ação explícita da pessoa, em um controle com nome ("Buscar em vários acervos"); nenhum filtro guardado, preferência antiga ou link liga o modo sozinho. Recarregar a página mantém a escolha só se ela foi feita nesta sessão de navegador (decisão assumida, ver abaixo).
- BR-3: o escopo é a união exata dos acervos marcados, cada um com seus sub-acervos (ADR 0028 §6); um acervo não marcado nunca entra, nem em uma ferramenta da pesquisa pedindo por id ou caminho.
- BR-4: só entram acervos que a pessoa pode abrir (`canOpen`); um acervo que perdeu o acesso sai da escolha sem erro, e a tela diz que saiu.
- BR-5: a tela sempre diz quais acervos valem: na barra lateral cada acervo marcado aparece selecionado, e o cabeçalho da conversa e da biblioteca nomeia os acervos (ou "3 acervos" com a lista ao abrir).
- BR-6: com um acervo só marcado, o modo se comporta exatamente como hoje (sem custo nem texto a mais).
- BR-7: a conversa salva guarda os acervos que valeram; reabri-la busca nos mesmos acervos, menos os que a pessoa não pode mais abrir (BR-4).

## Functional requirements
- FR-1: contrato: `topics: string[]` (1 a N slugs, sem repetição) ao lado de `topic` nas rotas de busca, pesquisa e biblioteca; a API valida cada slug contra o acesso da pessoa e resolve o escopo como a união de `Catalog.scope`. (BR-3, BR-4)
- FR-2: as ferramentas da pesquisa (`read_document`, `find_text`, `list_sources`, varredura, sub-agentes) recebem o escopo unido e recusam qualquer documento fora dele, como hoje recusam o de outro acervo. (BR-3)
- FR-3: web: o controle "Buscar em vários acervos" (Configurações ou a barra de escopo da conversa) liga o modo; ligado, as linhas de "Acervos" na barra lateral viram caixas de marcar; desligar volta ao acervo em uso. (BR-1, BR-2, BR-5)
- FR-4: resultados e citações trazem o nome do acervo de cada fonte. (BR-5)
- FR-5: a conversa salva grava `topics`; ao restaurar, aplica BR-4. (BR-7)

## Acceptance criteria
- AC-1 (BR-1, negativo): Given o modo desligado e Hermetismo em uso, When busco uma palavra que só existe em UDV, Then nada é encontrado e nenhuma fonte de UDV aparece.
- AC-2 (FR-1, BR-3): Given o modo ligado com Hermetismo e UDV marcados, When busco, Then aparecem fontes dos dois e de Palavra do Mestre (sub-acervo de UDV), e nenhuma de um terceiro acervo não marcado.
- AC-3 (FR-2, BR-3, negativo): Given o modo ligado com Hermetismo e UDV, When a Pesquisa com IA (perfis rápido, profundo e exaustivo) roda e uma ferramenta pede um documento de um acervo não marcado por id ou por caminho (`../outro/raw/x.md`), Then a ferramenta recusa e a resposta não o cita.
- AC-4 (BR-2, negativo): Given uma preferência antiga "todos os acervos" na conta, When abro o app, Then o modo está desligado e vale só o acervo em uso.
- AC-5 (BR-4, edge): Given UDV marcado e o acesso a UDV retirado, When volto a buscar, Then UDV sai da escolha, a tela diz "UDV saiu da busca: sem acesso" e a busca roda nos restantes.
- AC-6 (BR-5, UI): Given o modo ligado com dois acervos, Then em 1440 e em 390 as duas linhas estão marcadas na barra lateral (caixa marcada e `aria-checked`) e o cabeçalho nomeia os dois.
- AC-7 (BR-6): Given o modo ligado com um acervo só, Then a requisição é a mesma de hoje (`topic` único) e o tempo de resposta não muda (p95 da busca dentro de 5% do atual).
- AC-8 (FR-5, BR-7): Given uma conversa salva em Hermetismo e UDV, When a reabro, Then a busca usa os dois; sem acesso a UDV, só Hermetismo, com o aviso de AC-5.
- AC-9 (FR-4): Given resultados de dois acervos, Then cada resultado e cada citação mostram o nome do acervo.

## Test strategy
- AC-1..AC-3, AC-5: integração da API (vitest) com o vault de teste `apps/api/test/scope-vault.ts` (Hermetismo, UDV, UDV/Palavra do Mestre), nos módulos `search` e `research` (`collection-scope.test.ts`, `search-collection-scope.test.ts`).
- AC-4, AC-7: unidade do `ChatStore` e da página da biblioteca; AC-7 também com `pnpm --filter @kb-chat/api latency`.
- AC-6, AC-8, AC-9: E2E em `e2e` (Chromium, 1440 e 390) a partir de `media-collection-scope.spec.ts` e `research-collection-scope.spec.ts`.

## UI references
Figma `au1MI6z2Vwy9tnqOv2vrfH`: não há quadro de vários acervos; desenhar a barra lateral com caixas de marcar e o cabeçalho com mais de um acervo antes de implementar (`product-designer`).

## Architecture references
ADR 0028 (sub-acervos e escopo do pai) · ADR 0013/0021 (ferramentas e varredura) · ADR 0015 (autoria no contrato de busca). Mudar o contrato de `topic` para `topics` é difícil de reverter: pede ADR nova.

## Decisões assumidas (o dono pode mudar)
- O modo vale por sessão do navegador, não fica na conta (evita a mistura voltar sozinha, como aconteceu com "Todos os acervos").
- Sem limite de acervos além dos que a pessoa pode abrir; o custo da pesquisa cresce com o escopo e o painel de gasto já mostra isso.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] Test level chosen for every AC
- [ ] UI frame drawn (Figma) — falta
- [ ] ADR do contrato `topics` — falta
- [x] Depends on KBC-152 (a regra de um acervo só)
