---
id: KBC-138
title: "Gabarito de estudo: medir quanto a resposta do Profundo cobre do que o acervo tem"
status: ready
slice: complete-answers
outcome: a completude da Pesquisa com IA vira um número (cobertura de aspectos e precisão das citações) medido a cada mudança, começando pelo de hoje
depends_on: []
---

# KBC-138 — Gabarito de estudo e medição de cobertura

## Story
Como dono, quero um conjunto de perguntas de estudo com o que o acervo tem de importante sobre cada uma, para medir se a resposta do Profundo está completa e correta e para provar o ganho de cada melhoria seguinte.

## Scope
**In:**
- o formato do gabarito, com pergunta, aspectos esperados (cada um com os trechos que o sustentam e o autor) e o acervo;
- de 30 a 50 perguntas do Hermetismo, propostas pela IA a partir de uma varredura com o `find_text` e confirmadas pelo dono;
- o `agent-eval` estendido com cobertura de aspectos, recall dos trechos centrais e precisão das citações, por perfil;
- o relatório de partida do Profundo de hoje.

**Out:** usar o gabarito no CI com IA paga (o relatório é manual); gabarito de outros acervos (vem depois, com o mesmo formato).

## Business rules
- BR-1: um aspecto conta como coberto quando a resposta o trata e cita ao menos um dos trechos que o sustentam.
- BR-2: uma citação é precisa quando o trecho citado apoia a frase. Quem julga é um modelo verificador barato, com uma amostra conferida pelo dono.
- BR-3: o gabarito é versionado no repositório e só muda com a revisão do dono. As perguntas vêm de estudo real, não de títulos de documentos.

## Functional requirements
- FR-1: o `agent-eval` deve aceitar o formato do gabarito (`schemaVersion: 2`, com `aspects[]`) e manter o formato antigo. (BR-3)
- FR-2: para cada pergunta, o relatório deve dar os aspectos cobertos e os que faltaram, o recall dos trechos centrais e a precisão das citações; no fim, a média por perfil. (BR-1, BR-2)
- FR-3: um comando deve propor o gabarito de um assunto a partir da varredura completa (`find_text` com as variantes), para o dono confirmar. (BR-3)

## Non-functional requirements
- NFR-1: o relatório de 50 perguntas no Profundo roda em menos de 2 h na assinatura e fica dentro do teto diário quando o modelo é pago.

## Acceptance criteria
- AC-1 (FR-1, FR-2, BR-1): Given uma pergunta com 4 aspectos e uma resposta que cita trechos de 3 deles, When o eval roda, Then o relatório mostra cobertura 3/4 e nomeia o aspecto que faltou.
- AC-2 (BR-2): Given uma frase que cita um trecho que diz outra coisa, When o verificador julga, Then a citação conta como imprecisa.
- AC-3 (FR-1, negativo): Given um arquivo de perguntas no formato antigo, When o eval roda, Then funciona como hoje.
- AC-4 (FR-3): Given o assunto "Sete Princípios", When o comando de proposta roda, Then sai um rascunho com perguntas, aspectos e trechos, e cada trecho existe no vault.
- AC-5 (resultado): Given o gabarito confirmado pelo dono, When o Profundo de hoje é medido, Then o relatório de partida fica em `docs/research/` com cobertura e precisão.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2, AC-3 | unitário | Respostas e verificador fake |
| AC-4 | integração | Vault de fixture |
| AC-5 | manual (registrado) | Vault real, assinatura |

## References
`docs/research/2026-11-16-complete-answers-deep.md` · `apps/api/src/scripts/agent-eval.ts` · ADR 0004, 0013, 0021

## Decisões assumidas (o dono pode mudar)
- Meta de cobertura: 95 % dos aspectos; precisão das citações: 98 %.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
