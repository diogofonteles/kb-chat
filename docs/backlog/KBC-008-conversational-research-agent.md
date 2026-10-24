---
id: KBC-008
title: IA que pesquisa o acervo e conversa com contexto
status: in-progress
slice: release-1
outcome: responder qualquer pergunta com referência no acervo, sem o leitor refazer buscas
depends_on: [KBC-004, KBC-005]
---

# KBC-008 — IA que pesquisa o acervo e conversa com contexto

## Story
Quando estudo, quero perguntar como pergunto ao Claude e receber uma resposta analisada a partir de todo o acervo, que continue o assunto das perguntas anteriores e ligue o acervo ao que a IA já sabe, sem eu ter que refazer buscas.

Pedido do dono em 2026-10-24, depois de usar a release 1: "esperava que continuasse no contexto [...] tenho certeza que nos textos existe essa resposta [...] e ainda sugeriu refazer a busca com outro termo (coisa que ela mesma deveria ser inteligente o suficiente para fazer)"; "o resultado deve ser semelhante ao que temos no Claude [...] aproveitando todo o index que foi feito, resumos, ligações".

## Scope
**In:**
- Agente de pesquisa (ADR 0006) com as ferramentas `search_collection`, `list_subjects`, `read_document` e `related_documents` sobre o índice, os resumos e as relações do kb.
- Conversa com contexto: as perguntas seguintes recebem as perguntas e respostas anteriores da mesma conversa.
- **Duas visões**, escolhidas por um seletor fixo no topo:
  - **"Buscar documentos"**: o buscador sem IA de hoje, com cartões, filtros e painel.
  - **"Pesquisa com IA"**: um chat com o agente. Cada resposta mostra os passos (discretos), o texto em streaming, os documentos usados como fontes clicáveis, o custo e o botão "Parar".
- Cada visão tem a própria conversa e o próprio histórico. A visão inicial é "Pesquisa com IA" quando há provedor; sem provedor, é "Buscar documentos", com a outra desabilitada e uma explicação.

**Out:**
- Escolha de provedor e modelo na tela, e a assinatura do Claude/ChatGPT. Ficam no KBC-007; aqui vale o provedor do servidor.
- Busca na web.

## Business rules
- BR-1: a IA pesquisa antes de responder e nunca pede ao leitor para refazer a busca. Se, depois de pesquisar, o acervo não trouxer a resposta, ela diz o que procurou e o que encontrou.
- BR-2: fatos do acervo levam `[n]`, e n aponta para um documento que a IA leu. Conhecimento de fora do acervo pode complementar, mas vem marcado "(fora do acervo)".
- BR-3 *(emenda 2026-10-24)*: cada resposta tem no máximo **15** passos de ferramenta. Com provedor por token, o teto diário é verificado antes de cada chamada ao modelo, ao preço do orçamento de saída que o provedor de fato recebe (ADR 0004/0006); se o teto é atingido no meio, a IA para e explica.
  - *Texto original:* "no máximo 10 passos de ferramenta". Subiu para 15 junto com `find_text` e a leitura por janelas (commit `feeaa60`, ADR 0006), que dão ao agente mais passos curtos por resposta; o item fica alinhado ao que foi entregue.
- BR-4: o contexto de uma conversa é o texto das perguntas e respostas anteriores (não os documentos lidos). Uma conversa nova começa sem contexto.
- BR-5: na visão "Pesquisa com IA", perguntar já pesquisa com IA, sem um segundo clique. A estimativa deixa de ser um passo prévio e o custo real aparece ao final. Isso substitui a BR de "nunca roda sozinha" do KBC-004, por pedido do dono.
- BR-6: a visão "Buscar documentos" nunca chama a IA. A visão "Pesquisa com IA" não mostra cartões de busca, só os documentos que o agente usou.

## Functional requirements
- FR-1 *(emenda 2026-10-24)*: `POST /api/v1/topics/:topic/research` deve receber `{ question, history: [{question, answer}] }` e transmitir por SSE os eventos `step`, `sources`, `token`, `done` e `error`. Não há `mode`: o agente escolhe o modo de cada busca. A conversa é salva no histórico da API local (`PUT /api/v1/conversations/:id`, KBC-005 BR-1).
  - *Texto original:* `POST /api/v1/topics/:topic/conversations/turns` com `{ question, history, mode }`.
- FR-2: o agente deve usar as ferramentas do BR-1 com o provedor configurado (OpenRouter com tool calling; stub com roteiro nos testes).
- FR-3: na visão com IA, cada pergunta deve gerar uma resposta em streaming com:
  - a linha de passos ("Pesquisou 3 vezes · leu 4 documentos"), que se expande;
  - as fontes usadas, clicáveis, que abrem o painel do documento;
  - o rodapé com o custo e o aviso.
- FR-4: a web deve enviar o histórico da conversa na pergunta seguinte e mostrar a nova resposta abaixo, como no Claude.
- FR-5: o seletor "Buscar documentos | Pesquisa com IA" deve trocar de visão sem perder a conversa de nenhuma das duas. A visão escolhida fica lembrada no navegador.
- FR-6: o histórico da lateral deve guardar as conversas com IA com as respostas e fontes. Restaurar uma delas mostra as respostas salvas, sem chamar a IA de novo.

## Non-functional requirements
- NFR-1 *(emenda 2026-10-24)*: o primeiro passo visível aparece em até 3 s; a resposta típica (3 a 5 passos) termina em até 60 s com o modelo padrão, medido por `pnpm --filter @kb-chat/api agent-eval <perguntas.json> <relatório.md>` em 10 perguntas reais (o relatório traz o tempo até o primeiro passo e o total de cada uma).
  - *Texto original:* medido por `agent-latency`, script que não chegou a existir; o `agent-eval` mede latência, custo e citação juntos.
- NFR-2: custo médio ≤ US$ 0,02 por resposta com o modelo padrão, medido nas mesmas 10 perguntas.
- NFR-3: no conjunto de avaliação de 10 perguntas reais (incluindo "quais são os 5 princípios ocultos"), ≥ 8 respostas citam o documento que contém a resposta.

## Acceptance criteria
- **AC-1 (FR-1, FR-2, BR-1)**
  - Given o stub com um roteiro que busca, não acha e busca de novo com outro termo
  - When o leitor pergunta
  - Then aparecem os dois passos de busca e a resposta cita o documento achado na segunda busca
- **AC-2 (FR-4, BR-4)**
  - Given uma conversa com uma resposta anterior
  - When o leitor faz uma pergunta de seguimento
  - Then a requisição leva a pergunta e a resposta anteriores em `history`
  - And a nova resposta aparece abaixo
- **AC-3 (BR-2)**
  - Given uma resposta com `[2]`
  - When o leitor clica em `[2]`
  - Then abre o painel com o documento 2 das fontes
- **AC-4 (BR-3)**
  - Given um gasto do dia no limite
  - When o agente vai dar o próximo passo
  - Then ele para e aparece "Limite de gasto com IA de hoje atingido", com o caminho para ⚙ Configurações e sem "Tentar de novo" *(emenda 2026-10-24; texto original: "Limite de gasto de hoje atingido")*
- **AC-5 (FR-5)**
  - Given uma conversa em cada visão
  - When o leitor troca de visão e volta
  - Then as duas conversas continuam na tela
- **AC-6 (BR-6)**
  - Given a visão "Buscar documentos"
  - When o leitor pergunta
  - Then só a busca roda, sem chamada à IA
  - And a visão com IA não mostra cartões de busca
- **AC-9 (FR-6)**
  - Given uma conversa com IA no histórico
  - When o leitor a restaura
  - Then as respostas e fontes salvas aparecem sem nova chamada à IA
- **AC-7 (BR-3)**
  - Given um roteiro de stub com mais de 15 buscas
  - When o agente roda
  - Then ele para em 15 passos e responde com o que tem *(emenda 2026-10-24, BR-3; texto original: "15 buscas … para em 10 passos")*
- **AC-8 (NFR-3)**
  - Given o acervo real e o modelo padrão
  - When o conjunto de avaliação roda
  - Then ≥ 8/10 citam o documento esperado (relatório em `work/KBC-008/eval*.md`, um arquivo por rodada, com o provedor e o commit no cabeçalho) *(emenda 2026-10-24; texto original: `work/KBC-008/eval.md`)*

## Test strategy
| AC | Nível |
|---|---|
| AC-1, AC-4, AC-7 | Integração da API (stub com roteiro) |
| AC-2, AC-3, AC-5, AC-6, AC-9 | E2E Playwright (stub) + unit web |
| AC-8, NFR-1, NFR-2 | Script de avaliação no acervo real (custo baixo, registrado) |

## References
- ADR 0006 (agente de pesquisa), ADR 0004 (controles de gasto).
- Telas: `docs/design/screens.md` T4 (a revisar: resposta no topo, passos, documentos recolhíveis).

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope e outcome
- [x] BR/FR cobertos por AC
- [x] NFRs mensuráveis
- [x] Nível de teste por AC
- [x] Referências
- [x] Dependências feitas
