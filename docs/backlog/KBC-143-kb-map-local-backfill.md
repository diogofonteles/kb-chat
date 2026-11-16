---
id: KBC-143
title: "Mapa do acervo (5): mapear localmente o acervo que já existe, com a assinatura, e subir para a produção"
status: ready
slice: complete-answers
outcome: o Hermetismo inteiro (cerca de 3.000 documentos) e os outros acervos com o mapa pronto e verificado, sem custo por token além do plano
depends_on: [KBC-142]
---

# KBC-143 — Backfill local com a assinatura

## Story
Como dono, quero mapear o acervo que já existe no meu Mac usando a assinatura do Claude ou do Codex, e só depois mandar tudo para a produção, para pagar o mínimo e não arriscar a produção no caminho.

## Scope
**In:**
- `kb-map backfill <topic> --provider claude|codex`: lotes, progresso gravado por documento, pausa automática no limite de uso da assinatura e retomada na janela seguinte;
- o modelo por tarefa: o mais rápido para as seções, o mais forte para a árvore e os dossiês;
- o piloto (50 documentos e o assunto "Sete Princípios"), medido no gabarito (KBC-138), com o dossiê conferido pelo dono;
- o acervo inteiro;
- a subida: o check verde, o `sync-vault.sh`, e a conferência na produção;
- o mesmo para UDV e os outros acervos.

**Out:** usar o mapa na resposta (KBC-144).

## Business rules
- BR-1: o backfill nunca escreve na produção. Só o sync, depois do check verde (KBC-141), leva o mapa.
- BR-2: o piloto vem antes do acervo inteiro. O acervo inteiro só começa depois de o dono aprovar o dossiê do piloto.
- BR-3: o modelo pago (OpenRouter) só entra com o "sim" do dono, com o custo estimado antes.
- BR-4: o backfill é idempotente: parar e retomar não repete documentos prontos nem perde os parciais.

## Functional requirements
- FR-1: o backfill deve detectar o limite de uso do CLI (mensagem ou código de saída), pausar e retomar sozinho, registrando as pausas. (BR-4)
- FR-2: `kb-map backfill --status` deve mostrar documentos feitos e pendentes, tempo, pausas e a estimativa do que falta. (BR-4)
- FR-3: o relatório do piloto deve ter o tempo, a cota usada, a cobertura e a precisão no gabarito antes e depois, e o dossiê para o dono. (BR-2)

## Non-functional requirements
- NFR-1: o backfill do Hermetismo termina em ≤ 7 dias de calendário na assinatura, rodando em segundo plano no Mac, sem travar o transcritor.

## Acceptance criteria
- AC-1 (FR-1, BR-4): Given um CLI fake que responde "limite de uso" no documento 30, When o backfill roda, Then pausa, retoma depois e termina sem repetir os 29 primeiros.
- AC-2 (FR-3, BR-2): Given o piloto pronto, When o relatório é gerado, Then mostra a cobertura do gabarito antes e depois, e o acervo inteiro não começa sem a aprovação do dono.
- AC-3 (BR-1): Given o backfill no meio, When a produção é consultada, Then segue com o mapa anterior (ou sem mapa) e responde como hoje.
- AC-4 (resultado): Given o acervo inteiro mapeado e o check verde, When o sync roda, Then a produção tem o mapa, e `kb-map check` na VM passa.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | unitário (pytest) | CLI fake |
| AC-2, AC-4 | manual (registrado) | Mac do dono, produção |
| AC-3 | integração | API com e sem mapa |

## References
`docs/research/2026-11-16-complete-answers-deep.md` §5 · ADR 0019 (assinatura do Claude), ADR 0020 (Codex) · `docs/deploy/runbook.md` (sync do vault)

## Decisões assumidas (o dono pode mudar)
- O padrão é a assinatura do Claude. O Codex serve de alternativa quando a do Claude estiver no limite.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
