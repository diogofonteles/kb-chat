---
id: KBC-042
title: "Marcadores com nota: marcar um trecho, anotar, listar e voltar a ele"
status: ready
slice: phase-2-a
outcome: quem estuda guarda os trechos importantes de uma palestra com a própria anotação e volta a eles em um clique
depends_on: [KBC-041]
---

# KBC-042 — Marcadores com nota

## Story
Como quem estuda, quero marcar um trecho enquanto ouço, escrever uma nota e voltar a ele depois, para montar meu estudo sem anotar minutos num papel.

## Scope
**In:** botão "Marcar este trecho" e atalho B; nota opcional (até 2.000 caracteres) editável; aba "Marcadores" ao lado de "Transcrição" com a lista da mídia; marcas na barra de progresso; pular para o marcador; editar e apagar com "Desfazer"; lista "Meus marcadores" de todas as mídias na tela Mídia.
**Out:** compartilhar marcadores (fase D); exportar; marcadores em compilados (fase C).

## Business rules
- BR-1: um marcador é da pessoa que o criou; ninguém mais o vê, nem masters.
- BR-2: o marcador guarda a posição em ms do momento em que foi criado, menos 2 s (para pegar o começo da frase), nunca abaixo de 0.
- BR-3: se a mídia for removida, os marcadores dela são apagados junto.
- BR-4: perder o acesso ao acervo esconde os marcadores daquela mídia, sem apagá-los.

## Functional requirements
- FR-1: `POST/GET/PATCH/DELETE /api/v1/media/{id}/bookmarks` devem criar, listar, editar e apagar os marcadores da pessoa, com as regras de acesso do stream (404 sem acesso) e 404 ao tentar mexer no marcador de outra pessoa. (BR-1, BR-4)
- FR-2: "Marcar este trecho" (botão e B) deve criar o marcador sem pausar e abrir a nota em linha, com foco no campo; Enter salva, Esc fecha sem nota. (BR-2)
- FR-3: A aba "Marcadores" deve listar por posição (tempo, nota ou o texto da transcrição naquele ponto quando não há nota); clicar pula e toca; cada marcador também aparece como marca na barra de progresso, alcançável pelo teclado na lista.
- FR-4: Apagar deve mostrar "Marcador apagado" com **Desfazer** por 8 s, sem diálogo de confirmação (UP-07).
- FR-5: `GET /api/v1/media/bookmarks` deve listar os marcadores da pessoa em todas as mídias que ela ainda acessa, mais recentes primeiro, para a lista "Meus marcadores". (BR-4)

## Non-functional requirements
- NFR-1: criar um marcador responde na tela em ≤ 100 ms (otimista) e, se a API falhar, a tela avisa "Não consegui salvar o marcador." com **Tentar de novo**, sem perder a nota.
- NFR-2: 500 marcadores numa mídia rolam sem travar (INP ≤ 200 ms).

## Acceptance criteria
- **AC-1** (FR-2, BR-2): Given a mídia tocando em 12:40, When a pessoa aperta B, escreve "lei do ritmo" e Enter, Then surge o marcador em 12:38 com a nota, e o áudio não parou.
- **AC-2** (FR-3): Given três marcadores, When a pessoa clica no segundo na aba "Marcadores", Then o áudio pula para ele e toca; as três marcas aparecem na barra de progresso.
- **AC-3** (FR-4): Given um marcador, When a pessoa o apaga e clica "Desfazer" em até 8 s, Then ele volta igual, com a nota.
- **AC-4** (FR-1, BR-1): Given o marcador de outra pessoa, When alguém envia `PATCH` ou `DELETE` nele, Then recebe 404 e nada muda.
- **AC-5** (BR-4, FR-5): Given marcadores numa mídia de um acervo que a pessoa deixou de acessar, When abre "Meus marcadores", Then eles não aparecem; When o acesso volta, Then reaparecem.
- **AC-6** (BR-3): Given uma mídia com marcadores, When um master a remove, Then os marcadores dela somem do banco.
- **AC-7** (BR-2): Given a mídia em 0:01, When a pessoa marca, Then o marcador fica em 0:00.
- **AC-8** (NFR-1): Given a API fora do ar, When a pessoa marca com nota, Then vê o aviso com "Tentar de novo" e a nota continua no campo.
- **AC-9** (acessibilidade): Given só o teclado, When a pessoa marca, anota, navega pela lista e apaga com Desfazer, Then tudo funciona, sem violações sérias do axe em 1440 px e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-7 | unitário (regra de posição) + E2E | |
| AC-2, AC-3, AC-8 | componente + E2E | API fora do ar pelo `route.abort` |
| AC-4, AC-5, AC-6 | integração (API) | Duas contas de teste |
| AC-9 | E2E | axe nos três temas |
| NFR-2 | E2E com medição | 500 marcadores semeados |

## References
Tela: `docs/design/screens.md` T15 · ADR: [0025](../adr/0025-own-media-player-for-audio-and-video.md), [0022](../adr/0022-media-library-store-queue-and-streaming.md) · Benchmark: [`docs/research/2026-10-28-player-benchmark.md`](../research/2026-10-28-player-benchmark.md) · Barra de qualidade da fase 2: `docs/backlog/README.md`

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled; no open questions
- [x] Fits one goal
