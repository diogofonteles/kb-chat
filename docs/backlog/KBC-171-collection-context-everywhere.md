---
id: KBC-171
title: "O acervo em uso vale no app inteiro: filtros, listas, contagens e sugestões"
status: ready
slice: ui-v2-areas
outcome: com um acervo escolhido, 100% das listas, filtros, contagens e sugestões de todas as telas mostram só o que é dele (e dos seus sub-acervos); num acervo novo e vazio, nenhuma opção, contagem ou sugestão de outro acervo aparece
depends_on: [KBC-152, KBC-157]
---

# KBC-171 — O acervo em uso vale no app inteiro

Pedido do dono (2026-11-24), com duas capturas da Biblioteca no acervo novo "Cocreation" (0 mídias, 0 documentos): "quando eu seleciono um acervo, todo o contexto do app deve apontar apenas para ele, inclusive a Autoria e Assunto. Portanto, em um acervo novo como este do exemplo, não deveria haver nada nos dropbox de Autoria e Assunto. Precisa ser feita uma revisão completa no app para garantir que o contexto do acervo selecionado seja respeitado."

O que as capturas mostram: a lista está certa ("Nenhuma mídia neste acervo"), mas o filtro **Autoria** oferece Mestre Gabriel, Mestre Laércio, Alfredo Gabriel, Mestre Hilton e Outros autores, e o filtro **Assunto** oferece ~35 assuntos (Cabala, infância de Mestre Gabriel, Tradições Egípcia e Hermética…), todos de UDV e Hermetismo.

Causa já localizada: em `apps/api/src/modules/media/library-service.ts` (`page()`), a lista é filtrada pelo escopo do acervo (`topics: this.scope(actor, query.topic)`), mas as facetas saem de tudo o que a pessoa pode ver: `facetsOf(items)` e `distinctSubjects(subjects)` recebem os itens antes do filtro de acervo. A regra de escopo (KBC-152, ADR 0028 §6: o acervo e os seus sub-acervos, nunca outro acervo de primeiro nível) não chegou às facetas.

## Story

Como estudante com vários acervos, quero que, ao escolher um, tudo o que o app me mostra e me oferece seja desse acervo, para nunca filtrar, contar ou escolher algo que não pertence a ele.

## Scope

**In:** as facetas da Biblioteca (Autoria, Assunto, estados) pelo escopo do acervo; uma revisão completa, tela por tela, de tudo o que lista, conta, sugere ou filtra, com a correção de cada ponto fora do escopo; um teste por superfície.
**Out:** escolher vários acervos de propósito (KBC-161); "Ver todas as mídias" (continua sendo a única saída explícita do escopo, e nela as facetas são de todos os acervos); permissões por acervo (KBC-010).

## Business rules

- BR-1: o escopo é o acervo em uso com os seus sub-acervos (ADR 0028 §6). Nada de outro acervo de primeiro nível aparece em lista, filtro, contagem, sugestão ou atalho enquanto ele estiver em uso.
- BR-2: uma opção de filtro só existe se houver pelo menos um item do escopo que a satisfaça. Num acervo vazio, Autoria e Assunto não oferecem nada (o controle some ou fica desligado, como já acontece quando não há opções).
- BR-3: "Ver todas as mídias" (endereço `?acervos=todos`) é a única exceção, por escolha explícita; ali as opções são as de todos os acervos que a pessoa pode ver.
- BR-4: o que é da pessoa e não de um acervo (o gasto com IA, as preferências, as notificações) continua global, mas cada item que aponta para um acervo diz qual é.
- BR-5: trocar de acervo atualiza tudo na mesma tela, sem recarregar; um filtro escolhido que não existe no acervo novo é limpo, e a tela diz que foi.

## Functional requirements

- FR-1 (API): em `LibraryService.page()` e `search()`, as facetas (autores, outros autores, assuntos, estados) são calculadas sobre os itens do escopo (`this.scope(actor, query.topic)`), não sobre tudo. (BR-1, BR-2)
- FR-2 (revisão): conferir e, onde estiver fora do escopo, corrigir cada superfície abaixo; registrar o resultado de cada uma na matriz do item (dentro do escopo / corrigida / global por regra, com o motivo):
  - Biblioteca: facetas, contagem do topo, "Precisa da sua atenção", "Continuar ouvindo", "Ouvidas recentemente", busca na biblioteca, grade, seleção em massa, "Enviar mídia" (acervo de destino), autores do formulário de envio/edição.
  - /midia (quem não tem a Biblioteca) e o player: "Sobre a autora" e a contagem "N áudios em …", fila e marcadores abertos a partir do acervo.
  - Meus marcadores e Fila de processamento: a lista e as contagens da lateral.
  - Lateral "Sua biblioteca": Fixados (contagens), Conversas (de qual acervo são), Recentes, a busca da lateral.
  - Início da conversa: "Recentes", "Comece por um assunto", sugestões de pergunta, a dica do acervo.
  - Busca e Pesquisa com IA: facetas dos resultados (Autoria, Assunto, Sub-acervo), "Veja também", sugestões, página de assunto (prateleiras), a busca do topo (⌘K).
  - Documento: "Veja também" e a navegação entre documentos.
  - Sino de notificações e Configurações (Termos da transcrição, perfis de voz, transcritores): global por regra ou por acervo? decidir e registrar.
  - Celular: as mesmas superfícies nas folhas e no Menu.
- FR-3 (web): ao trocar de acervo, filtros que deixam de existir são limpos com um aviso curto. (BR-5)
- FR-4 (guarda): um teste de integração por rota que devolve listas ou facetas, com três acervos (A, B e o sub-acervo A/x) e um quarto vazio: no vazio, tudo vem vazio; em A vem A e A/x; nunca B.

## Acceptance criteria

- AC-1 (BR-2): Given o acervo novo "Cocreation" sem mídias, When abro a Biblioteca, Then Autoria e Assunto não oferecem nenhuma opção de outro acervo (os controles somem ou ficam desligados) e a contagem diz 0.
- AC-2 (BR-1): Given UDV em uso (com o sub-acervo Palavra do Mestre), When abro Autoria e Assunto, Then só aparecem autores e assuntos de áudios de UDV e de Palavra do Mestre; nenhum de Hermetismo.
- AC-3 (BR-3): Given "Ver todas as mídias" escolhido, When abro Autoria e Assunto, Then aparecem as opções de todos os acervos que posso ver.
- AC-4 (BR-5): Given o filtro Autoria "Mestre Laércio" em Hermetismo, When troco para UDV (onde ele não tem áudio), Then o filtro é limpo, a lista mostra UDV e a tela avisa que o filtro saiu.
- AC-5 (FR-2): Given cada superfície da lista do FR-2, When o acervo em uso é A, Then nada de B aparece nela (ou ela é global por regra registrada e nomeia o acervo de cada item).
- AC-6 (negativo, API): Given um pedido de facetas com `topic` de um acervo que não posso abrir, Then a resposta é a mesma recusa de hoje, sem vazar nomes de autores ou assuntos.
- AC-7 (celular): os mesmos AC-1 a AC-4 a 402 × 690 em WebKit.

## Test strategy

- API: integração de `GET /api/v1/media/library` e da busca com o vault de escopo (`apps/api/test/scope-vault.ts`, já com Hermetismo, UDV e UDV/Palavra do Mestre) mais um acervo vazio: AC-1, AC-2, AC-3, AC-6; um teste por rota do FR-4.
- Web (unidade): `library-controls` sem opções; troca de acervo limpa o filtro (AC-4).
- E2E (Chromium e WebKit, 1440 e 402 × 690): AC-1, AC-2, AC-4, AC-7 e um roteiro que percorre as superfícies do FR-2 com dois acervos e confere que nada do outro aparece (AC-5).

## Notes

- Achado relacionado da auditoria do celular (KBC-170, A-03/A-04): o conjunto de abas muda com o acervo em uso e a Biblioteca pode ficar sem aba; tratar junto para a regra ficar uma só.
- KBC-161 (vários acervos por escolha) passa a ser a única forma de ver mais de um acervo de primeiro nível ao mesmo tempo, além de "Ver todas as mídias".
