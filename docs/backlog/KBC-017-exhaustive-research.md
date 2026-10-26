---
id: KBC-017
title: Pesquisa exaustiva — busca literal sem teto, filtros por autor e origem, leitura de livros inteiros e o perfil "Exaustivo"
status: in-review
slice: release-1
outcome: uma pergunta exaustiva ("todas as obras citadas por José Laércio do Egito") é respondida varrendo o acervo inteiro, com uma linha de cobertura que diz quanto foi varrido
depends_on: [KBC-008, KBC-011]
---

# KBC-017 — Pesquisa exaustiva

## Story
Como dono do acervo, quero fazer perguntas exaustivas à Pesquisa com IA ("liste todas as obras citadas pelo autor X em todo o acervo") e receber a lista completa, para não depender de a IA "ver" só os 20 primeiros documentos ou só pedaços de livros enormes.

Pedido do dono em 2026-10-25, com uma resposta real como evidência: no perfil Profundo, a IA respondeu que não conseguia ser completa porque `find_text` devolve no máximo 20 documentos (livros grandes de outros autores ocupavam as vagas), não há como restringir a um autor, ela só lê janelas de 6 mil a 12 mil caracteres de compilações de 490 mil caracteres, para em 15 passos e escreve no máximo 2.000 tokens. O dono quer a pesquisa com IA "sem limitações", espelhada no funcionamento do Claude ("temos que nos espelhar no funcionamento do Claude"): uma busca como o Grep do Claude Code, uma leitura como o Read, compactação automática do contexto e o modelo decidindo o esforço.

Os sub-agentes em paralelo (orquestrador e trabalhadores, como a Research do claude.ai) ficam no KBC-018 (divisão confirmada pelo dono em 2026-10-25).

## Scope
**In:**
- `find_text` passa a funcionar como o Grep do Claude Code: `output_mode` `files` (lista compacta, uma linha por documento), `count` (ocorrências por documento) e `content` (cada ocorrência com contexto); `head_limit` e `offset` para paginar até o fim; sempre informa o total de documentos e de ocorrências; sem teto de documentos.
- Filtros em `find_text` e `search_collection`: `entity` (autor, pessoa ou obra das `entities` do kb; sem acento e maiúsculas, parcial), `source` (pasta de origem, trecho do `source_path`), `exclude` (números [n], ids ou um texto da origem ou das entidades) e `subjects` (já existia). Com `entity` ou `source` e sem `phrase`, `find_text` lista todos os documentos do filtro.
- `find_text` com `document` varre o corpo inteiro de um documento (o "scan_document" do pedido): todas as ocorrências, paginadas, com a posição para continuar a leitura.
- Nova ferramenta `list_sources`: pastas de origem e entidades mais frequentes, com contagens, filtráveis por texto.
- `read_document` com `limit` (tamanho da página, até 30 mil caracteres) além de `offset`; sempre informa o tamanho total e o próximo `offset`.
- `search_collection`: até 30 documentos por chamada, `offset`, linhas compactas e os mesmos filtros.
- Perfil novo "Exaustivo" (ao lado de Rápido e Profundo): orçamento de 80 passos (configurável), até 16 mil tokens na resposta, limite de tempo de 30 minutos, compactação automática do contexto e um prompt que manda enumerar com filtros e páginas até esgotar, varrer documentos grandes com `find_text` + `document`, manter a lista parcial e terminar com uma linha de cobertura.
- As mesmas ferramentas pelos dois caminhos: o laço por token da API e as assinaturas (Claude Code, Codex) pelas rotas MCP, com o limite de passos e a validade da sessão MCP ajustados ao perfil Exaustivo.
- O perfil fica salvo com o turno da conversa (100% do histórico).

**Out:**
- Sub-agentes em paralelo (`delegate`), progresso agrupado por sub-agente: KBC-018.
- Escolher um modelo próprio para o Exaustivo nas Configurações: ele usa o modelo do Profundo.
- Mudar a busca por sentido (QMD) para varrer além dos seus candidatos: enumerar tudo é trabalho do `find_text`.

## Business rules
- BR-1: nenhuma ferramenta corta resultados em silêncio: toda lista diz o total e, quando há mais, como pedir a próxima página.
- BR-2: uma página cabe no contexto: no máximo 200 linhas em `files`/`count` e 100 ocorrências em `content`, com trechos curtos.
- BR-3: o Exaustivo usa o modelo do Profundo; Rápido e Profundo mantêm o comportamento e as metas de latência da ADR 0009.
- BR-4: com provedor por token, o Exaustivo continua sujeito ao teto de gasto diário; ao atingir o teto, para e diz por quê.
- BR-5: a resposta do Exaustivo termina com uma linha de cobertura: quantos documentos do filtro foram varridos de quantos, e quantos documentos grandes foram lidos ou varridos.
- BR-6: a API nunca escreve no vault.

## Functional requirements
- FR-1: `find_text` aceita `output_mode` (`files` padrão, `count`, `content`), `head_limit`, `offset`, `entity`, `source`, `exclude`, `subjects` e `document`; `phrase` passa a ser opcional quando há `entity` ou `source`. (BR-1, BR-2)
- FR-2: a saída de `find_text` começa por uma linha com o total de documentos, de ocorrências, os filtros e a faixa da página; termina com "Próxima página: offset=…" ou "Fim da lista". (BR-1)
- FR-3: em `content`, cada ocorrência traz o documento [n], a posição no corpo e o contexto; a posição serve de `offset` para `read_document`. (BR-1)
- FR-4: `list_sources` lista pastas de origem e entidades com contagens, filtradas por `query`, paginadas. (BR-1)
- FR-5: `read_document` aceita `limit`; sempre mostra "caracteres a a b de total" e o próximo `offset`. (BR-1)
- FR-6: `search_collection` aceita `offset`, `entity`, `source`, `exclude` e até 30 documentos; diz quantos candidatos a busca por sentido trouxe. (BR-1)
- FR-7: o pedido de pesquisa aceita `profile: 'exhaustive'`; o compositor mostra "Rápido | Profundo | Exaustivo" com a ajuda "Varre o acervo inteiro…"; as Configurações oferecem o Exaustivo como perfil padrão. (BR-3)
- FR-8: no laço da API, o Exaustivo tem 80 passos (`KB_CHAT_EXHAUSTIVE_STEPS`, 10 a 300), resposta de até 16 mil tokens (`KB_CHAT_EXHAUSTIVE_OUTPUT_TOKENS`), 30 minutos de teto e compacta o contexto quando ele passa do limite: os resultados de ferramenta mais antigos viram um registro curto (o que foi chamado, totais, documentos [n] cobertos). (BR-3, BR-5)
- FR-9: nas assinaturas, o turno MCP do Exaustivo aceita os passos do perfil e vale por 90 minutos; o Claude Code compacta o próprio contexto. (BR-3)
- FR-10: o teto de gasto atingido no meio de um Exaustivo encerra o turno com a mensagem do limite diário, e o gasto feito é registrado. (BR-4)
- FR-11: o turno salvo guarda `profile`; turnos antigos continuam válidos sem ele. Citações com números de três dígitos ([123]) aparecem como fontes. (BR-1)

## Non-functional requirements
- NFR-1: no vault real (4.235 documentos), `find_text` com `entity` "José Laércio do Egito" responde a primeira página em ≤ 2 s com o cache quente e anda até o fim em páginas.
- NFR-2: `find_text` com `document` na maior compilação de Laércio (≈ 490 mil caracteres) devolve o total de ocorrências e a primeira página em ≤ 1 s.
- NFR-3: nenhuma saída de ferramenta passa de 60 mil caracteres (cabe no limite de saída MCP do Claude Code).
- NFR-4: WCAG 2.2 AA no compositor com três opções, em 1440 px e 390 px.

## Acceptance criteria
- **AC-1 (FR-1, FR-2, BR-1)**
  - Given um acervo com 25 documentos que contêm "vibração"
  - When o agente chama `find_text` com `phrase: "vibração"` e `head_limit: 10`
  - Then a saída diz "25 documento(s)", mostra 10 linhas, e termina com "Próxima página: offset=10"; com `offset: 20` mostra 5 linhas e "Fim da lista"
- **AC-2 (FR-1, BR-2)**
  - Given a mesma busca em `count`
  - When o agente pede sem `head_limit`
  - Then vê as 25 linhas com a contagem de cada documento, sem trechos
- **AC-3 (FR-1)**
  - Given documentos cujas `entities` incluem "José Laércio do Egito" e outros que não
  - When o agente chama `find_text` com `entity: "jose laercio"` e sem `phrase`
  - Then a lista traz só os do autor, com o total deles
- **AC-4 (FR-1)**
  - Given documentos de origens `_convert/Temas-docs/…` e `_convert/ready/…`
  - When o agente filtra com `source: "Temas-docs"` e `exclude: ["[2]"]`
  - Then só aparecem os da pasta, sem o documento [2]
- **AC-5 (FR-3, BR-1)**
  - Given um documento com mais de 100 mil caracteres e 40 ocorrências de "livro" espalhadas
  - When o agente chama `find_text` com `document`, `phrase: "livro | obra"`, `output_mode: "content"` e `head_limit: 30`
  - Then a saída diz o total de ocorrências do documento, mostra 30 com a posição e o contexto, e "Próxima página: offset=30"; a posição de uma ocorrência, usada em `read_document` como `offset`, abre o texto naquele ponto
- **AC-6 (FR-4)**
  - Given o acervo de fixture
  - When o agente chama `list_sources` com `query: "temas"`
  - Then vê a pasta `_convert/Temas-docs` com a contagem e as entidades que casam
- **AC-7 (FR-5)**
  - Given um documento de 150 mil caracteres
  - When o agente lê com `offset: 100000` e `limit: 20000`
  - Then vê "caracteres 100000 a 120000 de 150…" e o próximo `offset=120000`
- **AC-8 (FR-6)**
  - Given resultados da busca por sentido
  - When o agente pede `search_collection` com `entity` e `offset`
  - Then vê só os documentos da entidade, a partir do `offset`, e a indicação de quantos candidatos houve
- **AC-9 (FR-7, NFR-4)**
  - Given a Pesquisa com IA aberta
  - When a pessoa escolhe "Exaustivo"
  - Then a ajuda diz que varre o acervo inteiro e pode levar vários minutos, o pedido vai com `profile: "exhaustive"`, e o axe não acha violações sérias em 1440 e 390 px
- **AC-10 (FR-8, BR-5)**
  - Given um turno Exaustivo no laço da API cujo contexto passa do limite de compactação
  - When o próximo passo vai ao modelo
  - Then os resultados de ferramenta mais antigos foram trocados por um registro curto com os [n] cobertos, os mais recentes continuam inteiros, e o turno segue até a resposta
- **AC-11 (FR-8)**
  - Given um turno Exaustivo
  - When o modelo é chamado
  - Then ele recebe até 16 mil tokens de saída, o prompt pede a linha de cobertura, e o orçamento é de 80 passos; Rápido e Profundo continuam com 6 e 15 passos e 2.000 tokens
- **AC-12 (FR-9)**
  - Given uma assinatura (CLI) num turno Exaustivo
  - When o turno MCP é aberto
  - Then aceita até 80 chamadas de ferramenta e o prompt do Exaustivo vai ao CLI
- **AC-13 (FR-10, BR-4)**
  - Given um provedor por token com teto quase atingido
  - When um turno Exaustivo passa do teto no meio
  - Then o turno termina com o erro `DAILY_CAP_REACHED` e o gasto já feito entra no registro
- **AC-14 (FR-11)**
  - Given um turno Exaustivo terminado
  - When a conversa é salva e reaberta
  - Then o turno guarda `profile: "exhaustive"`, e uma citação [123] aparece entre as fontes

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1–AC-5 | unitário (`find-text-tool.test.ts`) | vault de fixture em memória com 25 documentos e um de 120 mil caracteres |
| AC-6 | unitário (`tools.test.ts`) | |
| AC-7 | unitário (`body-window.test.ts`, `tools.test.ts`) | |
| AC-8 | unitário (`tools.test.ts`) | busca falsa |
| AC-9 | unitário (`composer.spec`) + E2E (`research.spec.ts`) | 1440 e 390 px, axe |
| AC-10–AC-11 | unitário (`tool-loop-runner.test.ts`, `compaction.test.ts`) | LLM falso |
| AC-12 | unitário (`cli-runners.test.ts`, `mcp.test.ts`) | CLI falso |
| AC-13 | unitário (`tool-loop-runner.test.ts`) | razão de gasto falsa |
| AC-14 | unitário (`research-turn.spec`, `answer-format.spec`) + contrato | |
| NFR-1, NFR-2 | script local contra o vault real (só leitura) | números registrados na validação local |

## References
ADRs: `docs/adr/0006-research-agent-over-kb-tools.md`, `docs/adr/0007-ai-providers-and-local-settings.md`, `docs/adr/0009-faster-research-profiles-and-streaming.md`, `docs/adr/0013-exhaustive-research-grep-tools-and-compaction.md` · Telas: `docs/design/screens.md` (T1 compositor)

## Open questions
Nenhuma. Premissas registradas: o Exaustivo usa o modelo do Profundo; a compactação é determinística (sem chamada extra ao modelo); o nome na interface é "Exaustivo" (curto, ao lado de Rápido e Profundo, e diz o que faz).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
