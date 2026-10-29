---
id: KBC-039
title: "Mídia na busca: trechos falados aparecem nos resultados com o minuto exato, autoria e aviso de baixa confiança, e abrem o player no ponto"
status: ready
slice: phase-2-a
outcome: quem estuda acha uma ideia dita numa palestra no minuto exato pela mesma caixa de busca
depends_on: [KBC-036, KBC-038]
---

# KBC-039 — Mídia na busca, no minuto exato

## Story
Como quem estuda, quero que a busca também encontre o que foi dito nas palestras, abrindo o áudio no minuto certo, para não ouvir horas de gravação.

## Scope
**In:** índice FTS5 das transcrições atuais (ADR 0024); grupo "Na fala" nos resultados da busca com até 5 trechos (título, frase com as palavras destacadas, minuto, autoria, aviso de baixa confiança); clique abre o player 2 s antes; filtro de autoria e acervo valendo para a mídia; métrica de aberturas de trecho no log de uso.
Pedido do dono (2026-10-29): escolher o alcance da busca dentro do acervo ("Buscar em": textos, áudios e vídeos, juntos ou separados), e os trechos de mídia aparecerem como referências do mesmo jeito que os documentos, abrindo o player e tocando no ponto.
**Out:** sinônimos e busca por significado em mídia (fase B, B3); pesquisa com IA sobre mídia (fase C).

## Business rules
- BR-1: a busca em mídia respeita os acervos que a pessoa vê, como os documentos.
- BR-2: o filtro de autoria vale para a mídia; filtros que a mídia não tem (gênero, profundidade, conceitos) escondem o grupo "Na fala".
- BR-4: o alcance padrão é tudo o que o acervo tem (textos, áudios e vídeos); a escolha vale para a busca e é lembrada neste navegador; desmarcar todos não é possível (fica ao menos um).
- BR-3: trechos de transcrição de baixa confiança aparecem com o selo "baixa confiança" e depois dos de confiança normal com a mesma relevância.

## Functional requirements
- FR-1: Quando uma transcrição vira a atual, o sistema deve indexar seus segmentos no FTS5 na mesma transação, sem acento e sem diferenciar maiúsculas.
- FR-2: `POST /api/v1/topics/{topic}/searches` deve devolver, além do que já devolve, `media: [{ mediaId, title, authorship, text, highlights, startMs, confidence }]` (até 5), sem mudar os campos existentes.
- FR-3: A tela deve mostrar "Na fala" com os trechos e, ao clicar, abrir o player em `startMs − 2 s` com o segmento destacado.
- FR-5: A busca deve ter o controle "Buscar em: Textos · Áudios · Vídeos" (caixas de seleção com contagem, como as facetas), e a API deve aceitar `kinds: ['text','audio','video']`; um tipo que o acervo não tem fica desabilitado (vídeo até o KBC-035). (BR-4)
- FR-6: Os trechos de mídia devem aparecer na lista de referências junto com os documentos, ordenados pela relevância, cada um com o ícone do tipo (♪ áudio, ▶ vídeo), o título, o minuto e a frase com as palavras destacadas; clicar abre o player no painel de leitura (onde o texto abre) e toca do ponto, com o segmento destacado na transcrição. (FR-3)
- FR-4: A abertura de um trecho deve gerar o evento de uso `media_hit_opened` (a métrica principal da fase 2).

## Non-functional requirements
- NFR-1: a consulta em mídia tem p95 ≤ 150 ms com 2.000 h indexadas (corpus sintético) e não aumenta o p95 da busca exata acima de 1 s (Q1).

## Acceptance criteria
- **AC-1** (FR-1, FR-2, FR-3): Given uma palestra com "Tiuaco é Mariri" aos 08:15, When a pessoa busca "tiuaco mariri", Then "Na fala" mostra o trecho com 08:15 e, ao clicar, o player toca de 08:13.
- **AC-2** (FR-1): Given a busca "hoasca" sem acento ou "HOASCA", When executada, Then encontra "Hoasca".
- **AC-3** (BR-1): Given uma pessoa sem acesso ao acervo da palestra, When busca o mesmo termo, Then nenhum trecho dela aparece.
- **AC-4** (BR-2): Given o filtro "Mestre Laércio", When busca, Then só aparecem trechos de mídia com essa autoria; Given um filtro de gênero ativo, Then o grupo "Na fala" não aparece.
- **AC-5** (BR-3): Given um trecho de baixa confiança e um normal com o mesmo termo, When busca, Then o normal vem antes e o outro tem o selo "baixa confiança".
- **AC-6** (FR-1): Given uma mídia retranscrita, When busca uma palavra que só existia na versão antiga, Then ela não aparece.
- **AC-7** (FR-4): Given a abertura de um trecho, When o log de uso é lido, Then existe um `media_hit_opened` com a mídia e o minuto.
- **AC-9** (FR-5, BR-4): Given um acervo com documentos e áudios, When a pessoa desmarca "Textos" e busca "hoasca", Then só aparecem trechos de áudio; When marca de novo, Then aparecem os dois, misturados por relevância.
- **AC-10** (FR-6): Given um trecho de áudio nas referências, When a pessoa clica nele, Then o player abre no painel de leitura e toca do minuto do trecho menos 2 s, com o segmento destacado.
- **AC-8**: resultados com "Na fala" em 1440 px e 390 px, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-8 | E2E | Transcrição falsa semeada |
| AC-2, AC-3, AC-4, AC-5, AC-6 | integração | |
| AC-7 | integração | |
| NFR-1 | script de carga local | Corpus sintético de 2.000 h |

## References
ADR: [0024](../adr/0024-media-search-outside-the-vault.md) · Plano da fase 2 v3 (A6, métrica principal) · Contrato de busca: `libs/contracts/src/search.ts`

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled (KBC-036, KBC-038); no open questions
- [x] Fits one goal
