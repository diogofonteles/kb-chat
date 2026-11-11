---
id: KBC-110
title: "O histórico de conversas respeita o nível de hoje: fontes que a pessoa não vê mais aparecem como restritas, com aviso, e o espelho local é trocado pelo do servidor"
status: ready
slice: levels-release-1
outcome: depois de um rebaixamento de nível, reabrir uma conversa antiga não mostra título, trecho nem link de fonte acima do nível atual
depends_on: [KBC-104]
parent: LEVELS
---

# KBC-110 — Histórico respeita o nível de hoje

## Story
Como master, quero que ao rebaixar o nível de alguém as conversas antigas dessa pessoa deixem de mostrar as fontes que ela não pode mais ler, para que o histórico não seja uma porta para o conteúdo restrito.

## Scope
**In:** máscara na leitura (`GET /conversations/:id` e a lista) das fontes de respostas da IA guardadas: fonte invisível agora vira `{ restricted: true }` sem id, título, autoria ou trecho, e o turno ganha `restrictedSources: n`; aviso na resposta; citação `[n]` de fonte restrita não abre nada; o `PUT` não devolve fontes ocultas a quem salva; a web troca o espelho local (`localStorage`) pelo que o servidor devolve ao abrir; a mesma regra quando a pessoa perde o acesso ao acervo inteiro.
**Out:** reescrever a prosa da resposta (decisão do dono: mantida); conversas de busca (são refeitas ao abrir e já passam pelo KBC-103).

## Business rules
- BR-1: a leitura de uma conversa aplica a `LevelView` de hoje às fontes de cada resposta; a prosa fica.
- BR-2: uma fonte restrita não mostra título, autoria, trecho, id nem link; só "Fonte restrita".
- BR-3: a resposta com fontes restritas diz quantas: "2 fontes desta resposta não estão disponíveis para você.".
- BR-4: o que o cliente envia num `PUT` nunca faz o servidor devolver uma fonte oculta.
- BR-5: o espelho local não mostra fonte que o servidor marcou como restrita.

## Functional requirements
- FR-1: `conversations-service.ts` mascara as fontes na leitura com a visão de cada acervo da conversa; o arquivo gravado não muda. (BR-1, BR-2)
- FR-2: `answerSourceSchema` ganha `restricted?: true` (aditivo) e o turno `restrictedSources?: number`. (BR-2, BR-3)
- FR-3: a resposta do `PUT` vem mascarada como a leitura. (BR-4)
- FR-4: ao abrir uma conversa, a web substitui a cópia local pela do servidor; `pending-saves` não reintroduz fontes. (BR-5)
- FR-5: o chip `[n]` de fonte restrita fica como texto, sem botão. (BR-2)

## Non-functional requirements
- NFR-1: mascarar uma conversa de 50 turnos com 20 fontes cada leva p95 ≤ 20 ms.

## Acceptance criteria
- **AC-1** (BR-1, BR-2, BR-3): Given Ana em CDC com uma resposta que citou 3 fontes (QS, CI, CDC), When o master a põe em CI e ela reabre a conversa, Then a prosa aparece, as fontes QS e CI aparecem como antes, a terceira aparece como "Fonte restrita" e o aviso diz "1 fonte desta resposta não está disponível para você.".
- **AC-2** (BR-2, negativo): Given o mesmo caso, Then o JSON de `GET /conversations/:id` não contém o título, o id nem o trecho do documento CDC.
- **AC-3** (BR-1): Given o master volta Ana para CDC, When ela reabre, Then a fonte volta a aparecer completa (o arquivo nunca perdeu nada).
- **AC-4** (BR-4): Given o cliente envia num `PUT` a conversa com a fonte CDC completa, Then a resposta do `PUT` e a leitura seguinte vêm mascaradas.
- **AC-5** (BR-5): Given o `localStorage` com a versão antiga completa, When Ana abre a conversa, Then a tela mostra a versão mascarada do servidor.
- **AC-6** (borda: acesso revogado): Given Ana perde o acesso ao acervo, When abre a conversa daquele acervo, Then todas as fontes aparecem restritas.
- **AC-7** (FR-5): Given a citação `[3]` de fonte restrita, When Ana clica, Then nada abre e o leitor de tela lê "Fonte 3, restrita".
- **AC-8** (sem regressão): Given conversas sem fontes restritas, Then aparecem como hoje.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-4, AC-6 | integração | `conversations-levels.integration.test.ts`, busca do título oculto no JSON inteiro |
| AC-5, AC-7 | componente + E2E | `history-store` e `answer-sources`; `e2e/specs/levels.spec.ts` em 1440 e 390 |
| AC-8 | existentes | sem mudança |
| NFR-1 | teste de desempenho | — |

## References
ADR [0036](../adr/0036-access-levels-per-collection.md) §8 · KBC-029 (turnos gravados) · Tela T4 (fontes) com a emenda de 2026-11-06.

## Open questions
Resolvidas em 2026-11-07 (dono, conversa: "aprovo todos"), com o padrão recomendado:
- A prosa da resposta guardada fica e só as fontes restritas são escondidas.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR e tela
- [x] Depende do KBC-104
- [x] Cabe num goal
