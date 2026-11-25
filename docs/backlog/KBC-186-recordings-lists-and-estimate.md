---
id: KBC-186
title: "Gravações por link, canais e playlists com escolha, vídeo como transcrição e estimativa de custo"
status: in-review
slice: complete-answers
outcome: uma palestra do YouTube ou um canal entra no acervo pela tela, sabendo antes quanto custa
depends_on: [KBC-149, KBC-184]
---

# KBC-186 — Gravações por link, canais e playlists com escolha, vídeo como transcrição e estimativa de custo

## Story
Como quem cuida de um acervo, quero colar o link de uma palestra, de um canal ou de uma playlist e escolher o que entra, sabendo antes quanto deve custar.

Pedido do dono em 2026-11-25: "seria interessante o app fazer uma estimativa de custo do que vai ser adicionado, antes de inserir". Decisão: um vídeo entra só como transcrição.

## Business rules
- BR-1: um link de gravação (YouTube, Vimeo, Instagram, SoundCloud, podcast, arquivo de mídia) vira a gravação de quem mandou, com os direitos dele na hora.
- BR-2: de um canal ou playlist o Mac lista, a pessoa escolhe, e só o escolhido entra.
- BR-3: a estimativa vem do que os últimos itens do mesmo tipo custaram aqui.
- BR-4: um arquivo de vídeo entra pelo som.

## Acceptance criteria
- AC-1: Given um canal, When listado, Then nada entra antes da escolha.
- AC-2: Given itens escolhidos, Then o custo e o tempo estimados aparecem antes de incluir, e o aviso quando passam do teto.
- AC-3 (negativo): Given uma transmissão ao vivo ou um arquivo acima de 2 GB, Then o item falha com o motivo.

## References
- ADR [0041](../adr/0041-adding-content-from-one-page.md), [0040](../adr/0040-source-conversion-and-document-uploads.md).
