---
id: KBC-189
title: "Transcritores: o Mac que acorda sozinho aparece como tal, com o comando certo"
status: ready
slice: complete-answers
outcome: na produção, a tela Transcritores diz que o Mac acorda a cada 5 min, em vez de "desligado"
depends_on: [KBC-188]
---

# KBC-189 — O Mac que acorda sozinho, na tela Transcritores

## Story
Como dono, quero ver na produção que o Mac está pareado e acorda sozinho, sem ler "desligado" entre um despertar e outro, e com o comando que liga o serviço certo.

## Business rules
- BR-1: um transcritor que diz acordar sozinho (perfil com `StartInterval`, KBC-188) aparece como "acorda a cada 5 min", com a hora do último despertar.
- BR-2: o comando sugerido para ligá-lo na hora é o do rótulo dele (`…transcriber.<perfil>`).

## References
KBC-188; revisão e QA do KBC-188 (`work/KBC-188/review.md`, `qa.md`).
