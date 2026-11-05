---
id: KBC-096
title: "Busca da Biblioteca por faixa: a fala primeiro, só o que atende, abrindo no ponto exato"
status: ready
slice: phase-2-a
outcome: quem busca na Biblioteca acha a faixa e o minuto de uma fala, como numa biblioteca de música
depends_on: [KBC-039, KBC-051, KBC-068, KBC-070]
---

# KBC-096 — Busca da Biblioteca por faixa

## Story
Como quem estuda, quero buscar na Biblioteca como numa biblioteca de faixas, para ir direto ao trecho falado sem passar pelas faixas que não importam. A entrevista é o álbum; as partes, as faixas.

## Scope
**In:** `GET /api/v1/media/library/search`; resultado por faixa com o melhor trecho; ordem fala → título e autor → assunto; tela só de resultado com texto na caixa; ▶ e abrir no ponto; palavras na URL.
**Out:** busca por prefixo na fala (a fala casa palavra inteira); sinônimos; índice novo.

## Business rules
- BR-1: uma linha por faixa; passagem dentro de faixa é da faixa (KBC-068 BR-6). Áudio sem faixas e trecho entre faixas respondem como a gravação.
- BR-2: fala (confiança normal, relevância) antes de título e autor, antes de assunto; uma mídia aparece uma vez.
- BR-3: gravação achada só por título ou autor é uma linha. Faixa só entra pelo autor quando ele difere do da gravação.
- BR-4: sem `search`, nenhuma transcrição é consultada e nenhum resumo responde (o resumo deriva da fala): só título, autor e nome do assunto; sem `media-tracks`, só gravações; sem `media-subjects`, nem assunto nem resumo. Só mídia pronta, não arquivada, nos acervos que a pessoa vê.
- BR-5: os filtros em vigor valem na busca. Na tela ficam só Acervo e Limpar filtros; a ordem é a relevância e a visão é lista.
- BR-6: no máximo 200 resultados, em páginas de 50.

## Non-functional requirements
- NFR-1: com 2.000 h em faixas, a consulta à fala tem p95 ≤ 150 ms e a busca inteira p95 ≤ 400 ms (`media-search-latency.ts`).

## Acceptance criteria
- **AC-1** (BR-1): Given "padre orlando" dito em 2 de 3 faixas, When a pessoa busca "padre orlando", "Padre Orlando" ou "PADRE ORLÂNDO", Then só essas 2 faixas aparecem, com o trecho marcado e o tempo da faixa.
- **AC-2** (BR-1): Given um áudio sem faixas e um trecho entre faixas, When buscados, Then respondem como a gravação, no tempo dela.
- **AC-3** (BR-2, BR-3): Given o termo na fala e no título da gravação, When busca, Then as faixas que falam vêm antes, e a gravação depois, numa linha só.
- **AC-4** (BR-4): Given alguém sem `search`, When busca uma palavra só falada, Then nada aparece e a resposta não traz fala; pelo título, a faixa aparece sem trecho.
- **AC-5** (BR-4): Given alguém sem `media-tracks`, Then a gravação responde no tempo dela; de acervo que a pessoa não vê, nada aparece; sem `media-library`, 403.
- **AC-6** (BR-5): Given Acervo e chips em vigor, When busca, Then só o que eles deixam aparece.
- **AC-7**: Given texto na caixa, Then "Continuar ouvindo", "Ouvidas recentemente", "Todas", ordenação e visão somem desde a primeira tecla e o resultado é o primeiro conteúdo sob a caixa; **Limpar busca** devolve tudo e o foco à caixa.
- **AC-8**: Given um resultado com trecho às 8:15, When toca, Then ouve de 8:13; When abre, Then o player está em 8:13, pausado; When volta, Then a busca continua lá.
- **AC-9**: Given nada encontrado, Then a mensagem diz onde buscou, com **Limpar busca** e, com filtro, **Limpar filtros**; **Buscar na fala** não existe.
- **AC-10**: Given um trecho longo em 390 px, Then não há rolagem lateral e o termo aparece.
- **AC-11**: Given só o teclado e leitor de tela, Then tudo funciona, a contagem é anunciada, e o axe não acha violações sérias.
- **AC-12**: Given digitação rápida, Then uma resposta atrasada de palavras antigas nunca substitui a nova, e "nada encontrado" não pisca.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-6 | integração | `library-search.integration.test.ts` |
| AC-7 a AC-12 | componente + E2E | `library-page.spec.ts`, `media-library-search.spec.ts` |
| NFR-1 | script de carga local | `media-search-latency.ts --strict` |

## References
ADR: [0024](../adr/0024-media-search-outside-the-vault.md) · Telas: T16 em `docs/design/screens.md` · Pedido do dono: 2026-11-04.

## Open questions
Nenhuma.
