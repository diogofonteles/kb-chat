---
id: KBC-187
title: "Remover um documento do acervo pelo app, e trazer de volta"
status: in-review
slice: complete-answers
outcome: um master tira um documento do acervo pela tela, sem terminal, e nada é apagado
depends_on: [KBC-149, KBC-184]
---

# KBC-187 — Remover um documento do acervo pelo app, e trazer de volta

## Story
Como master, quero tirar do acervo um documento que não devia estar lá, pela tela, sabendo que posso trazê-lo de volta.

Pedido do dono em 2026-11-25: "como faço pra remover um documento do acervo pelo app?" e "precisamos ter essa opção pelo app".

## Business rules
- BR-1: só masters removem e trazem de volta.
- BR-2: a remoção vale na hora no app (busca, leitura, Pesquisa com IA, contagens), antes de o Mac mover o arquivo.
- BR-3: nada é apagado: o Mac usa a quarentena do próprio kb, e o original fica em `raw/_originals`.
- BR-4: pede confirmação com o nome, o acervo e a informação de que dá para trazer de volta.
- BR-5: uma resposta antiga mantém o texto; a fonte removida não abre, para ninguém.
- BR-6: o que foi removido pode ser enviado de novo.
- BR-7: a faixa de uma gravação e as páginas que o kb escreve (conceitos) não se removem por aqui.

## Functional requirements
- FR-1: `POST /api/v1/topics/:topic/documents/:id/removal`, `GET /api/v1/document-removals`, `POST /api/v1/document-removals/:id/restore` e `/retry` (masters).
- FR-2: o Mac leva e traz pelo `doc-ingest` (`remove`, `restore`), de graça, antes dos envios.
- FR-3: "Remover do acervo" no menu ⋯ do documento; "Removidos do acervo" em Configurações.

## Acceptance criteria
- AC-1: Given um documento do acervo, When um master confirma "Remover do acervo", Then ninguém o acha nem o lê, mesmo antes de o Mac mover o arquivo.
- AC-2: Given um removido, When o master escolhe "Trazer de volta", Then ele volta ao acervo com o nível que tinha; antes de o Mac levar, volta na hora.
- AC-3: Given quem não é master, When tenta remover, listar ou trazer de volta, Then a API recusa (403) e a tela não oferece.
- AC-4: Given o Mac que não conseguiu, Then a lista diz por quê, o documento continua fora, e "Tentar de novo" pede outra vez.
- AC-5: Given uma conversa antiga que cita o removido, Then o texto fica e a fonte aparece como restrita.
- AC-6: Given um removido, When o mesmo arquivo ou link é enviado, Then ele entra.

## References
ADR 0041 §10; ADR 0036 §8; `apps/api/src/modules/document-removals`.
