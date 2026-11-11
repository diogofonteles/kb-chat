---
id: KBC-083
title: "Faixas, títulos, nomes pelo contexto e assuntos nunca dependem do Mac: a IA da aplicação é o padrão e o modelo local é só um local opcional"
status: ready
slice: phase-3-server-processing
outcome: com nenhum computador pareado, propor faixas, títulos, nomes pelo contexto e assuntos funciona do início ao fim, a ≤ US$ 0,05 por hora de áudio
depends_on: [KBC-067, KBC-069]
---

# KBC-083 — Etapas de texto sem o Mac

## Story
Como quem edita gravações, quero que as propostas da IA (faixas, títulos, quem fala pelo contexto e assuntos) funcionem sem nenhum computador pessoal ligado, para editar de qualquer lugar.

## Scope
**In:** conferir e garantir que `propose` e `classify` rodam pela IA da aplicação (ADR 0016) com DeepSeek V4 Flash como primeiro modelo (teste de faixas do KBC-063: 4 de 4 janelas válidas, US$ 0,0048/h, 37 s/h) e reserva conforme o KBC-067; o trabalho `propose` no Mac (modelo local) fica como local opcional, nunca o padrão enquanto o modelo local não passar no critério do KBC-063 (≥ 80 % das faixas aceitas); quando o local opcional estiver primeiro e nenhum computador o pegar em N horas, passa à IA da aplicação; teste E2E do fluxo de edição inteiro (KBC-072) sem nenhum worker de texto pareado; nenhuma tela diz "aguardando o transcritor" para etapas de texto.
**Out:** escolher ou trocar o modelo (KBC-067); áudio (as etapas de texto só mandam a transcrição, ADR 0029 §7).

## Business rules
- BR-1: `propose` e `classify` têm sempre a IA da aplicação na lista de locais; o modelo local é opcional e só entra se um master o puser.
- BR-2: o modelo local só pode ser o primeiro local se o último teste de faixas aprovado pelo dono (≥ 80 % das faixas aceitas) for com ele.
- BR-3: valem os tetos do KBC-067 (US$ 0,25 por análise, teto mensal da mídia) para a IA da aplicação; o local custa 0.
- BR-4: só o texto da transcrição sai, para o provedor escolhido pelo master (KBC-067 BR-7); a privacidade de áudio (KBC-078) não se aplica a esta etapa.

## Functional requirements
- FR-1: Com a configuração padrão e nenhum computador pareado, "Propor com IA" e "Sugerir assuntos" devem rodar pela IA da aplicação e terminar. (BR-1)
- FR-2: Com [Computador pareado, IA da aplicação] em `propose`, um trabalho que não for reservado em N horas deve passar à IA da aplicação com a estimativa de custo reservada antes. (BR-1, BR-3)
- FR-3: A tela "Processamento" deve recusar tirar a IA da aplicação de `propose`/`classify` e recusar pôr o modelo local em primeiro sem o teste aprovado. (BR-1, BR-2)

## Non-functional requirements
- NFR-1: custo ≤ US$ 0,05 por hora de áudio somando faixas e assuntos, medido pelo livro da mídia em 3 gravações reais.
- NFR-2: a proposta de 1 h de áudio termina em ≤ 2 min pela IA da aplicação (37 s/h medidos).

## Acceptance criteria
- **AC-1** (FR-1): Given nenhum computador pareado e o LLM falso, When quem edita escolhe "Propor com IA" no envio, Then as faixas aparecem no passo 2 e o passo 3 abre.
- **AC-2** (FR-2): Given `propose` = [Computador pareado, IA da aplicação] com N = 1 h, When passa 1 h sem reserva, Then a proposta roda pela IA da aplicação e mostra o custo real.
- **AC-3** (FR-3, BR-1, negativo): Given a tela, When o master tenta deixar `propose` só com "Computador pareado", Then a tela recusa com "A IA da aplicação precisa ficar como reserva" e o `PUT` responde 422.
- **AC-4** (BR-2): Given o modelo local sem teste aprovado, When o master tenta pô-lo em primeiro, Then a tela recusa com o motivo.
- **AC-5** (BR-3, teto): Given US$ 0,25 de teto por análise e uma gravação cuja estimativa passa disso, When pede a proposta, Then ela não roda e a tela diz por quê.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 | E2E | LLM falso, sem worker pareado |
| AC-2, AC-5 | integração | relógio falso |
| AC-3, AC-4 | integração + E2E | |
| NFR-1, NFR-2 | manual | 3 gravações; gasto ≤ US$ 0,20 |

## References
ADR: [0031](../adr/0031-processing-location-per-step.md), [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) (§7, decisão 3), [0016](../adr/0016-house-ai-plan-and-access-policy.md) · Pesquisa: [teste de faixas](../research/2026-11-03-audio-editing-test-tracks.md) · Itens: KBC-067, KBC-069, KBC-072, KBC-079

## Open questions
Nenhuma (a IA paga para texto já foi aprovada na decisão 3 da ADR 0029; este item só garante que nada exige o modelo local). Se o KBC-079 ainda não existir quando este item rodar, o FR-2 e o FR-3 valem sobre a configuração do KBC-067.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled (KBC-067, KBC-069); no open questions
- [x] Fits one goal
