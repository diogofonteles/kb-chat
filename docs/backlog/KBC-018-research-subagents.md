---
id: KBC-018
title: Pesquisa exaustiva com sub-pesquisadores em paralelo (orquestrador e trabalhadores)
status: in-review
slice: release-1
outcome: uma pergunta exaustiva é dividida pelo orquestrador entre sub-pesquisadores com contexto próprio, que trabalham em paralelo e devolvem resumos citados; a resposta junta tudo, sem estourar o contexto do orquestrador
depends_on: [KBC-017]
---

# KBC-018 — Sub-pesquisadores em paralelo

## Story
Como dono do acervo, quero que a pesquisa Exaustiva divida o trabalho entre vários pesquisadores que trabalham ao mesmo tempo, cada um com a própria memória de trabalho, para que perguntas que exigem varrer centenas de documentos e livros inteiros sejam respondidas por completo, como a Research do claude.ai e os agentes do Claude Code fazem.

Pedido do dono em 2026-10-25 ("temos que nos espelhar no funcionamento do Claude"): o modelo decide o esforço; o orquestrador planeja, distribui tarefas focadas (por exemplo, "extrair todas as obras citadas nos documentos 1–60 desta lista", "varrer o livro X inteiro e listar as obras citadas"), cada sub-agente trabalha com contexto novo e as mesmas ferramentas só de leitura e devolve só o resultado condensado com as citações; o orquestrador junta e tira repetições. Dividido do KBC-017 com a concordância do dono.

## Scope
**In:**
- Ferramenta `delegate` só no perfil Exaustivo do laço da API: de 1 a 5 tarefas por chamada, cada uma com título curto e instrução completa.
- Cada sub-pesquisador: contexto novo (prompt próprio + a tarefa), as mesmas ferramentas de pesquisa (sem `delegate`), orçamento próprio de passos, compactação de contexto como no orquestrador, e devolve um relatório curto com [n].
- Até 3 sub-pesquisadores ao mesmo tempo; os demais esperam a vez.
- As fontes que os sub-pesquisadores numeram entram na mesma numeração da resposta (as citações [n] deles valem na resposta final).
- Progresso: cada passo de um sub-pesquisador chega ao leitor marcado com o número dele; a lista de passos mostra "Pesquisador N" e o resumo diz quantos pesquisadores trabalharam.
- "Parar" interrompe o orquestrador e todos os sub-pesquisadores.
- Provedor por token: os sub-pesquisadores contam no mesmo teto diário; o teto atingido encerra o turno com `DAILY_CAP_REACHED` e o gasto feito fica registrado.
- Assinatura do Claude (Claude Code): o perfil Exaustivo libera o agente nativo de sub-tarefas com um agente "pesquisador" restrito às ferramentas do acervo (MCP); o texto dos sub-agentes nunca entra na resposta; cada delegação aparece como um passo.
- Prompt do Exaustivo: quando a varredura for grande, dividir entre sub-pesquisadores e juntar.

**Out:**
- Sub-agentes no Codex (assinatura do ChatGPT, desligada por padrão): o Exaustivo funciona sem delegação.
- Agrupar por sub-agente os passos do caminho do Claude Code (o MCP não diz qual sub-agente chamou a ferramenta): ficam sem número.
- Sub-pesquisadores que delegam de novo (um nível só).

## Business rules
- BR-1: só o perfil Exaustivo delega; Rápido e Profundo não veem `delegate`.
- BR-2: um sub-pesquisador nunca escreve para o leitor: só o orquestrador responde.
- BR-3: os números [n] são os mesmos para o orquestrador e todos os sub-pesquisadores de um turno.
- BR-4: o teto diário vale para a soma do turno, sub-pesquisadores incluídos.
- BR-5: parar o turno para tudo; nenhuma chamada de modelo começa depois.

## Functional requirements
- FR-1: `delegate { tasks: [{ title, task }] }` (1–5) existe só nos turnos Exaustivos do laço da API; o resultado volta como um texto por tarefa ("Pesquisador N — título") com o relatório do sub-pesquisador. (BR-1)
- FR-2: cada sub-pesquisador roda com no máximo 25 passos, 4.000 tokens por chamada, compactação e a última chamada sem ferramentas; no máximo 3 rodam juntos. (BR-2)
- FR-3: `step` ganha `agent` (número do sub-pesquisador) e o tipo `delegate`; o web mostra "Pesquisador N: …" na lista e "· N pesquisadores" no resumo; eventos antigos sem `agent` continuam válidos. (BR-3)
- FR-4: as fontes dos sub-pesquisadores entram no evento `sources` do turno. (BR-3)
- FR-5: o abort do leitor chega a todos os sub-pesquisadores. (BR-5)
- FR-6: o guarda de gasto de cada chamada de sub-pesquisador conta o que o turno inteiro já gastou; `done.steps` soma os passos de todos. (BR-4)
- FR-7: no Claude Code, o Exaustivo passa `--agents` com o agente "pesquisador" (prompt de sub-pesquisador e só as ferramentas `mcp__kb__*`) e libera a ferramenta de sub-agentes; texto de linhas com `parent_tool_use_id` é ignorado; cada chamada de sub-agente vira um passo `delegate`. Rápido e Profundo continuam sem ferramentas nativas. (BR-1, BR-2)

## Non-functional requirements
- NFR-1: três sub-pesquisadores rodam de fato em paralelo (o tempo do turno de teste fica perto do mais lento, não da soma).
- NFR-2: nenhum texto de sub-pesquisador aparece na resposta (testado com o modelo falso).
- NFR-3: WCAG 2.2 AA na lista de passos com sub-pesquisadores, 1440 e 390 px.

## Acceptance criteria
- **AC-1 (FR-1, BR-1)**
  - Given um turno Exaustivo no laço da API
  - When o modelo vê as ferramentas
  - Then `delegate` está entre elas; num turno Rápido ou Profundo, não
- **AC-2 (FR-1, FR-2, FR-4, BR-3)**
  - Given o orquestrador delega 3 tarefas
  - When os sub-pesquisadores pesquisam e respondem citando [n]
  - Then o orquestrador recebe 3 relatórios, cada um com as citações deles, as fontes do turno incluem os documentos que eles numeraram, e a resposta final pode citá-los
- **AC-3 (FR-2, NFR-1)**
  - Given 5 tarefas, cada sub-pesquisador levando o mesmo tempo
  - When o orquestrador delega
  - Then nunca mais de 3 rodam ao mesmo tempo e o tempo total fica perto de 2 rodadas, não de 5
- **AC-4 (FR-3)**
  - Given sub-pesquisadores trabalhando
  - When eles chamam ferramentas
  - Then os eventos `step` trazem `agent: N`; a lista de passos mostra "Pesquisador N: Procurando …" e o resumo "· 3 pesquisadores"
- **AC-5 (FR-5, BR-5)**
  - Given sub-pesquisadores no meio do trabalho
  - When o leitor clica em "Parar"
  - Then nenhuma chamada de modelo começa depois e o turno termina como interrompido
- **AC-6 (FR-6, BR-4)**
  - Given um teto diário que os sub-pesquisadores ultrapassam
  - When o próximo passo de um deles iria ao modelo
  - Then o turno termina com `DAILY_CAP_REACHED` e o registro guarda o gasto de todos
- **AC-7 (BR-2, NFR-2)**
  - Given um sub-pesquisador que escreve texto
  - When ele termina
  - Then nenhum `token` dele chega ao leitor
- **AC-8 (FR-7)**
  - Given a assinatura do Claude num turno Exaustivo
  - When o CLI é iniciado
  - Then os argumentos trazem `--agents` com o "pesquisador" restrito às ferramentas do acervo e a ferramenta de sub-agentes liberada; num turno Profundo, `--tools ""` como antes; linhas com `parent_tool_use_id` não viram texto da resposta; uma chamada de sub-agente vira um passo "Delegando: …"

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2, AC-3, AC-5, AC-6, AC-7 | unitário (`subagents.test.ts`, `tool-loop-runner.test.ts`) | modelo falso roteirizado por tarefa, relógio real com atrasos curtos |
| AC-4 | unitário (`research-steps.spec`, `research-message.spec`) + E2E (`research.spec.ts`) | E2E com o modelo falso do servidor de E2E |
| AC-8 | unitário (`cli-runners.test.ts`) | CLI falso, sem o `claude` real |

## References
ADRs: `docs/adr/0013-exhaustive-research-grep-tools-and-compaction.md`, `docs/adr/0014-research-subagents.md` · Telas: `docs/design/screens.md` (T1, lista de passos)

## Open questions
Nenhuma. Premissas: até 3 em paralelo, 5 tarefas por chamada, 25 passos por sub-pesquisador (redes de segurança; o modelo decide quantos usar); o rótulo na interface é "Pesquisador N".

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
