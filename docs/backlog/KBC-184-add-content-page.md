---
id: KBC-184
title: "Adicionar conteúdo: uma página para arquivos, pastas, links, áudio e vídeo, com teto e andamento"
status: in-review
slice: complete-answers
outcome: quem tem permissão cria um acervo e o enche pela tela, sem terminal e sem perder nada em silêncio
depends_on: [KBC-148, KBC-149]
---

# KBC-184 — Adicionar conteúdo

## Story
Como quem cuida de um acervo, quero uma página em que eu escolha arquivos, uma pasta inteira, links ou áudios e veja o que aconteceu com cada um, para montar o acervo sem o terminal.

Pedidos do dono em 2026-11-25: "todo o mecanismo atual de criar acervo e adicionar documentos … totalmente pronto no app"; "selecionar uma pasta e garantir que todos os arquivos da pasta sejam enviados"; "não vejo nenhum status de andamento... deveria ter mais detalhes"; "tem algum lugar no app para fazer essa revisão?".

## Business rules
- BR-1: só quem tem `media-upload` no acervo vê a página e os atalhos.
- BR-2: cada inclusão tem um teto (padrão US$ 0,50, de 0,05 a 100), e o que não cabe espera, com o motivo.
- BR-3: a conta do envio sempre fecha; o que não entra aparece com o motivo, e o que falhou e foi tirado da lista continua dito.
- BR-4: o envio continua enquanto a pessoa usa o app; fechar a aba avisa antes.
- BR-5: um acervo criado na tela ganha a pasta no cofre com o primeiro item.
- BR-6: o que o kb recusa é decidido na própria linha: o motivo e o que foi lido aparecem para quem enviou; um master inclui mesmo assim ou deixa de fora (nada é apagado do cofre).

## Acceptance criteria
- AC-1: Given uma pasta com subpastas, When escolhida, Then tudo o que pode entrar vai, e o resto aparece com o motivo.
- AC-2: Given um envio em curso, When a pessoa sai da página e volta, Then nada parou e a conta está lá.
- AC-3 (negativo): Given quem não tem permissão, When abre o endereço, Then volta ao início e a API responde 403.
- AC-4: Given itens esperando, When nenhum Mac está conectado, Then a tela diz isso e o que fazer.
- AC-5: Given um item em curso, Then a etapa, a posição na fila, o tempo e o gasto aparecem.
- AC-6: Given um item recusado pelo kb, When um master escolhe "Incluir mesmo assim", Then ele entra no acervo; When escolhe "Deixar de fora", Then sai da lista e continua na quarentena do kb. Quem não é master vê o motivo e o que foi lido, e não decide (API 403).

## References
- ADR [0041](../adr/0041-adding-content-from-one-page.md), [0040](../adr/0040-source-conversion-and-document-uploads.md).
