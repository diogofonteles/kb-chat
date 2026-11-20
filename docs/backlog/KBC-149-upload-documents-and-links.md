---
id: KBC-149
title: "Enviar documento e link pelo app: PDF, Office, EPUB, imagem, URL e YouTube entram no acervo com o mesmo tratamento de um texto"
status: ready
slice: complete-answers
outcome: quem tem permissão acrescenta textos ao acervo pela tela, sem passar pelo Mac à mão, e eles entram no mapa como qualquer outro
depends_on: [KBC-148, KBC-142]
---

# KBC-149 — Enviar documento e link pelo app

## Story
Como quem cuida de um acervo, quero enviar um PDF, um livro em EPUB, um link ou um vídeo do YouTube pelo app, para que entre no acervo e nas respostas sem eu precisar de ninguém no Mac.

## Scope
**In:**
- nas ações da biblioteca (o "+ Criar" da v2 deixou de existir: KBC-164 separou "+ Nova conversa" e o "+" de Acervos), a opção "Enviar documento ou link", com arquivo (envio retomável, como o da mídia, ADR 0033) ou URL;
- a fila "Documentos em processamento", na Fila de processamento, com os estados: recebido, convertendo, classificando, no mapa, pronto ou falhou;
- um job novo para o Mac (`doc-ingest`) que roda o `kb-map convert` (KBC-148), depois `kb ingest`, `classify`, `link`, `kb-map update` e o sync, o mesmo caminho do `kb-publish`;
- o YouTube passa pelo transcritor como uma mídia, e daí pelo mesmo tratamento (KBC-142 BR-5).

**Out:** edição do texto depois de convertido; envio em lote de pastas.

## Business rules
- BR-1: só envia quem tem a permissão de enviar para aquele acervo (a mesma de mídia, ou uma própria se o dono preferir), e o documento nasce no nível padrão do acervo.
- BR-2: a API nunca escreve no vault (Q7): ela guarda o arquivo e cria o job, e só o Mac converte e escreve.
- BR-3: um documento repetido (mesmo hash de original) não entra duas vezes. A pessoa vê o que já existe.

## Functional requirements
- FR-1: `POST /api/v1/topics/:topic/documents` (arquivo ou `{ url }`, schema no `@kb-chat/contracts`) deve guardar o envio e criar o job `doc-ingest`. (BR-1, BR-2)
- FR-2: o transcritor marcado "Publica no acervo" deve pegar o job, rodar a sequência e informar cada estado; uma falha mostra o motivo. (BR-2)
- FR-3: o envio repetido deve responder com o documento existente. (BR-3)

## Non-functional requirements
- NFR-1: um PDF de 100 páginas fica "pronto" em ≤ 15 min com o Mac ligado.

## Acceptance criteria
- AC-1 (FR-1, FR-2): Given Ana com permissão, When envia um PDF, Then ele passa pelos estados até "pronto" e aparece na busca e no mapa.
- AC-2 (BR-1, negativo): Given Beto sem permissão, When tenta enviar, Then a API responde 403 e as ações da biblioteca não mostram a opção.
- AC-3 (BR-3): Given um PDF que já está no acervo, When reenviado, Then a pessoa vê "Este documento já está no acervo" com o link.
- AC-4 (FR-2): Given uma URL que não converte, When o job roda, Then o estado é "falhou" com o motivo, e nada entra no acervo.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | E2E + integração (transcritor stub) | — |
| AC-2, AC-3 | integração (API) + E2E | Permissões |
| AC-4 | integração | Conversor fake |

## References
`docs/research/2026-11-16-source-to-raw.md` · ADR 0033 (envio retomável), 0035 (kb-publish) · KBC-148, KBC-142 · `docs/design/redesign-v2.md` · KBC-164 (fim do "+ Criar")

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
