---
id: KBC-144
title: "Profundo guiado pelo mapa: a resposta trata cada aspecto do assunto e mostra o mapa ao estudante"
status: ready
slice: complete-answers
outcome: no gabarito (KBC-138), a resposta do Profundo cobre ≥ 95 % dos aspectos esperados, sem o estudante precisar saber o que o acervo tem
depends_on: [KBC-143, KBC-120]
---

# KBC-144 — Profundo guiado pelo mapa

## Story
Como estudante que não domina o tema, quando pergunto no Profundo, quero uma resposta que trate tudo o que o acervo tem de importante sobre o assunto, para estudar sem medo de ter ficado algo de fora.

## Scope
**In:**
- o app (não a IA) situa a pergunta nos nós da árvore, usando os sinônimos e uma chamada curta à IA;
- o app carrega os dossiês desses nós, filtrados pelo que a pessoa vê (níveis, KBC-110);
- a IA recebe os trechos centrais de cada aspecto e escreve a resposta por aspecto;
- a busca por termos e por sentido completa o que está fora do mapa e os documentos "pendentes no mapa";
- o app confere se todo aspecto foi tratado ou descartado com motivo e, se faltou algum, manda a IA tratar antes de entregar;
- no fim da resposta, a linha "Esta resposta cobre os N aspectos que o acervo trata sobre <assunto>", com os aspectos clicáveis.

**Out:** o Rápido (segue como hoje); o Exaustivo (segue a varredura da ADR 0021, que pode partir do mapa num item futuro); a verificação de citações (KBC-145).

## Business rules
- BR-1: o conjunto de aspectos de uma resposta é o dos dossiês dos nós da pergunta, restrito ao que a pessoa pode ver. Um aspecto só com trechos invisíveis para ela não aparece nem é contado.
- BR-2: um aspecto só pode ficar de fora da resposta com um motivo dito ("não se aplica à pergunta"), registrado no turno.
- BR-3: a pergunta que não cai em nenhum nó segue o Profundo de hoje, e a resposta diz que o assunto ainda não está no mapa.
- BR-4: os documentos "pendentes no mapa" entram pela busca e contam na cobertura.

## Functional requirements
- FR-1: a Pesquisa com IA deve, no Profundo, situar a pergunta, carregar os dossiês e montar o plano de aspectos antes da primeira chamada de escrita. (BR-1, BR-3)
- FR-2: depois da resposta, o app deve comparar os aspectos tratados com o plano e pedir os que faltaram, até 2 vezes. (BR-2)
- FR-3: o turno salvo deve ter o plano de aspectos, os tratados e os descartados com motivo; o web mostra a linha de cobertura e a lista. (BR-2)
- FR-4: a busca deve incluir os documentos pendentes na fase de completar. (BR-4)

## Non-functional requirements
- NFR-1: no gabarito, cobertura de aspectos ≥ 95 % e precisão das citações ≥ 98 % no Profundo (relatório do KBC-138).
- NFR-2: o primeiro texto da resposta aparece em ≤ 8 s no p95, como no Profundo de hoje (ADR 0009).

## Acceptance criteria
- AC-1 (FR-1, FR-2): Given o dossiê Ritmo com 6 aspectos, When Ana pergunta "o que o acervo ensina sobre a lei do ritmo?" no Profundo, Then a resposta trata os 6 e mostra "cobre os 6 aspectos".
- AC-2 (FR-2, BR-2): Given a primeira resposta da IA sem 1 aspecto, When o app confere, Then pede o aspecto e a resposta final o trata.
- AC-3 (BR-1, permissão): Given um aspecto só com trechos de um nível que Ana não vê, When ela pergunta, Then o aspecto não aparece nem é contado, e nenhum texto dele vaza (suíte do KBC-111).
- AC-4 (BR-3): Given uma pergunta fora do mapa, When respondida, Then segue o Profundo de hoje e diz que o assunto ainda não está no mapa.
- AC-5 (BR-4): Given um documento novo "pendente no mapa" sobre o ritmo, When Ana pergunta, Then ele é achado pela busca e pode ser citado.
- AC-6 (NFR-1): Given o gabarito, When o eval roda depois da entrega, Then cobertura ≥ 95 % e precisão ≥ 98 %.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2, AC-4, AC-5 | integração (API) | Mapa e modelo fakes |
| AC-3 | integração | `levels-leakage.integration.test.ts` estendida |
| AC-1 (UI) | E2E | Linha de cobertura e lista, 1440 e 390 |
| AC-6 | manual (registrado) | Gabarito real, assinatura |

## References
`docs/research/2026-11-16-complete-answers-deep.md` §3 · ADR 0006, 0009, 0021 · KBC-127 (a Pesquisa com IA na v2) · KBC-111 (vazamento)

## Decisões assumidas (o dono pode mudar)
- A linha de cobertura aparece sempre que a pergunta cai no mapa, mesmo com todos os aspectos cobertos: é o mapa do assunto para o estudante, não um aviso.
- Uma ADR nova registra o Profundo guiado pelo mapa (emenda a ADR 0006).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
