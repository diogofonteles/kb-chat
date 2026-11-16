---
id: KBC-145
title: "Verificação de citações: nenhuma frase da resposta sem apoio no trecho que ela cita"
status: ready
slice: complete-answers
outcome: precisão das citações ≥ 98 % no gabarito; uma frase que o acervo não sustenta não chega ao leitor
depends_on: [KBC-144]
---

# KBC-145 — Verificação de citações

## Story
Como estudante, quero que cada afirmação da resposta esteja de fato no trecho citado, para confiar no que estudo.

## Scope
**In:**
- antes de entregar, o app confere cada frase com citação contra o trecho citado, com um modelo verificador barato;
- a frase sem apoio é reescrita a partir do trecho ou retirada;
- vale para o Profundo e o Exaustivo;
- o resultado da verificação fica no turno.

**Out:** frases sem citação (a ADR 0004 já pede citação a toda afirmação sobre o acervo); o Rápido (opcional depois, por custo).

## Business rules
- BR-1: uma frase tem apoio quando o trecho citado diz o mesmo; quando o trecho diz outra coisa ou nada sobre aquilo, ela não tem.
- BR-2: uma frase sem apoio nunca chega ao leitor: é corrigida com o trecho ou sai. O que foi corrigido fica registrado.
- BR-3: no streaming (ADR 0009), a correção usa o mecanismo de retirar e substituir que já existe.

## Functional requirements
- FR-1: a Pesquisa com IA deve verificar cada frase citada, em paralelo, antes de fechar o turno. (BR-1)
- FR-2: uma frase sem apoio deve ser reescrita uma vez e verificada de novo; se ainda não tiver apoio, deve sair. (BR-2, BR-3)
- FR-3: o turno salvo deve ter quantas frases foram verificadas, corrigidas e retiradas. (BR-2)

## Non-functional requirements
- NFR-1: a verificação acrescenta ≤ 4 s ao fim da resposta no p95 e ≤ US$ 0,01 por resposta com o modelo pago.

## Acceptance criteria
- AC-1 (FR-1, BR-1): Given uma frase que repete o trecho citado, When verificada, Then passa sem mudança.
- AC-2 (FR-2, BR-2): Given uma frase que atribui ao trecho algo que ele não diz, When verificada, Then é reescrita com o que o trecho diz, ou sai.
- AC-3 (BR-3): Given a resposta em streaming com uma frase corrigida, When o turno fecha, Then o leitor vê só a versão corrigida.
- AC-4 (NFR-1, resultado): Given o gabarito, When o eval roda, Then precisão ≥ 98 %.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2 | unitário | Verificador fake |
| AC-3 | integração (API) + E2E | Stream de fixture |
| AC-4 | manual (registrado) | Gabarito real |

## References
ADR 0004 (respostas ancoradas), ADR 0009 (streaming com retirada) · `docs/research/2026-11-16-complete-answers-deep.md` §3

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
