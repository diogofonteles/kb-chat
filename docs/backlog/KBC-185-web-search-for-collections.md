---
id: KBC-185
title: "Pesquisar na web para montar um acervo: assunto, quantidade, tipos e autores, sem repetir"
status: in-review
slice: complete-answers
outcome: quem cuida de um acervo acha e escolhe fontes na web sem sair do app
depends_on: [KBC-149, KBC-184]
---

# KBC-185 — Pesquisar na web para montar um acervo

## Story
Como quem cuida de um acervo, quero pedir uma pesquisa por assunto, dizendo quantas fontes, quais tipos (texto, áudio, vídeo) e quais autores, para escolher o que entra.

Pedidos do dono em 2026-11-25: "um lugar onde o usuário possa pedir para pesquisar (feito fazemos com o firecrawl)"; "como faço para incluir mais? … como eu garanto que ele não trará resultados que já me trouxe antes? … eu não pedi para incluir limites"; "veja que trouxe resultados totalmente distintos do termo que pesquisei".

## Business rules
- BR-1: nada entra sem a pessoa escolher; o que ela escolhe entra como link, com a estimativa e o teto.
- BR-2: sem limite de fontes nem de autores; a busca vai até a quantidade pedida ou até não achar mais, e pode ser parada.
- BR-3: o que a pessoa já recebeu, ou que o acervo já tem, não volta, em outro dia também, a não ser que ela peça.
- BR-4: o que não fala do assunto nem do autor é descartado.
- BR-5: a chave do Firecrawl é da casa, selada (ADR 0017); só masters a ligam e veem o saldo; abaixo de 100 créditos há aviso.

## Acceptance criteria
- AC-1: Given quatro nomes separados por vírgula, When adicionados, Then são quatro autores.
- AC-2: Given 30 fontes pedidas e 10 achadas na primeira rodada, Then a tela mostra as 10 e segue procurando.
- AC-3: Given uma busca feita, When "Buscar mais 30", Then só vêm novas, somadas às que estão na tela.
- AC-4 (negativo): Given um resultado sem relação com o assunto, Then ele não aparece.
- AC-5 (negativo): Given sem chave ou sem créditos, Then a tela diz o que fazer.

## References
- ADR [0041](../adr/0041-adding-content-from-one-page.md), [0040](../adr/0040-source-conversion-and-document-uploads.md).
