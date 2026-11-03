---
id: KBC-086
title: "Fila justa e cotas de processamento: vez por pessoa, prioridade dada por master, e tetos mensais de gasto e de horas por pessoa e por acervo"
status: draft
slice: phase-3-server-processing
outcome: com várias pessoas enviando, nenhum envio de 1 h espera mais que 2 h por causa do lote de outra pessoa, e nenhum acervo ou pessoa passa do seu teto mensal
depends_on: [KBC-079]
---

# KBC-086 — Fila justa e cotas de processamento

## Story
Como pessoa que envia uma palestra enquanto outra importa um acervo inteiro, quero que o meu áudio entre na vez, e como master quero tetos por pessoa e por acervo, para o gasto e a espera serem previsíveis.

## Scope
**In:** escolha do próximo trabalho por vez entre as pessoas que pediram (rodízio), depois por idade; "Subir prioridade" por master numa mídia; tetos mensais por acervo (gasto em US$) e por pessoa (gasto em US$ e horas de áudio processadas em locais pagos), editáveis em "Processamento"; reserva contra os três tetos (mídia, acervo, pessoa) antes de qualquer local pago; tela da pessoa mostrando o que já usou no mês; avisos a 80 % e 100 %.
**Out:** cotas de envio (tamanho e quantidade: KBC-035); cobrar pessoas; prioridade paga.

## Business rules
- BR-1: entre os trabalhos que um local pode pegar, o próximo é o da pessoa que foi atendida há mais tempo; empate, o mais antigo. Exceção: trabalhos com prioridade dada por master vão antes.
- BR-2: um trabalho pago reserva contra o teto da mídia (padrão US$ 10/mês), o do acervo (padrão a decidir) e o da pessoa que pediu (padrão a decidir); se qualquer um não couber, não sai e a mídia diz qual teto bloqueou.
- BR-3: locais gratuitos (computador pareado, servidor) não gastam teto de US$, mas contam horas para o relatório.
- BR-4: o mês é o do calendário em America/Recife (como a cota diária do KBC-061); o que foi reservado e não gasto volta.
- BR-5: só quem tem `media-processing-settings` muda tetos e prioridades.

## Functional requirements
- FR-1: A reserva de um worker ou adaptador deve escolher o próximo trabalho pela regra de vez e prioridade. (BR-1)
- FR-2: Antes de um local pago, o sistema deve reservar contra os três tetos numa transação única e recusar com o teto que bloqueou. (BR-2, BR-4)
- FR-3: `PUT /api/v1/media/processing-quotas` deve gravar os tetos por acervo e por pessoa (padrão e exceções); sem a permissão, 403. (BR-5)
- FR-4: A tela da pessoa ("Meu uso de mídia") deve mostrar horas e US$ do mês e o teto; a dos masters, por acervo e por pessoa.
- FR-5: A 80 % e a 100 % de um teto, o sistema deve avisar na tela (masters e a pessoa) uma vez por mês e por teto.

## Non-functional requirements
- NFR-1: em simulação com 1 pessoa enviando 50 h e outra 1 h, o trabalho de 1 h começa antes de 2 h de espera (relógio falso, 1 local de 17× tempo real).
- NFR-2: a reserva nos três tetos leva ≤ 20 ms p95 com 5.000 trabalhos na fila.

## Acceptance criteria
- **AC-1** (BR-1, FR-1): Given 50 trabalhos da Ana e 1 do Bruno na fila, When o local termina o trabalho atual da Ana, Then o próximo é o do Bruno.
- **AC-2** (BR-1 exceção): Given um master subiu a prioridade de um trabalho da Ana, When o local pede o próximo, Then pega esse.
- **AC-3** (BR-2, FR-2): Given o acervo A com teto de US$ 5 e US$ 4,98 gastos, When um trabalho de A iria ao Groq com estimativa de US$ 0,04, Then não sai e a mídia diz "Teto mensal do acervo atingido".
- **AC-4** (BR-2): Given a pessoa com teto de 5 h pagas e 5 h usadas, When pede outra transcrição paga, Then não sai e ela vê "Você usou as 5 h deste mês".
- **AC-5** (BR-3): Given a mesma pessoa, When o trabalho vai ao computador pareado, Then roda e o teto em US$ não muda.
- **AC-6** (BR-4, limite): Given o teto esgotado em 31/10 às 23:59 (Recife), When chega 1/11 às 00:00, Then o trabalho que esperava pode sair.
- **AC-7** (BR-5, permissão): Given uma pessoa sem a permissão, When tenta mudar tetos, Then 403.
- **AC-8** (FR-5): Given 80 % do teto do acervo, When um trabalho é lançado, Then os masters veem o aviso uma vez.
- **AC-9**: telas de uso em 1440 px e 390 px, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, NFR-1 | unitário (escolha) + integração | fast-check sobre filas aleatórias |
| AC-3, AC-4, AC-5, AC-6 | integração | relógio falso |
| AC-7 | integração | |
| AC-8, AC-9 | E2E | axe |

## References
ADR: [0031](../adr/0031-processing-location-per-step.md) (§5, §7), [0022](../adr/0022-media-library-store-queue-and-streaming.md) (§2, §7) · Itens: KBC-061, KBC-079

## Open questions
- Tetos padrão? Padrão recomendado: mídia US$ 10/mês (como hoje); por acervo US$ 5/mês; por pessoa 5 h de áudio pagas por mês. — owner: dono

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (ADR 0031 proposta)
- [ ] Dependencies done or scheduled; no open questions
- [x] Fits one goal
