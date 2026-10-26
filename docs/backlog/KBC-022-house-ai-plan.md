---
id: KBC-022
title: "Plano da casa: a IA gratuita da aplicação, configurada pelo master na tela"
status: in-review
slice: release-1
outcome: qualquer pessoa convidada pesquisa com IA sem configurar nada, dentro de uma cota diária, com custo zero ou visível; a produção não precisa de nenhuma chave de IA no .env
depends_on: [KBC-007, KBC-010, KBC-017]
---

# KBC-022 — Plano da casa: a IA gratuita da aplicação

## Story
Como master, quero conectar a conta OpenRouter da aplicação pela tela, escolher os modelos gratuitos e dar a cada pessoa uma cota diária de pesquisas, para que os poucos convidados usem a Pesquisa com IA sem configurar nada e sem custo, e eu saiba sempre quem gastou o quê.

Decisão do dono em 2026-10-26: "Nada deve ser configurado por nós via código; tudo pela UI do usuário." O custo tem de ser muito baixo e transparente. Pesquisa de 2026-10-26: o OpenRouter tem modelos `:free` (20 pedidos/min; 50 por dia com menos de US$ 10 comprados na conta, 1000 por dia com US$ 10 ou mais), o roteador `openrouter/free`, a lista `models` que cai para o próximo modelo e cobra só o que respondeu, e a conexão de conta por OAuth PKCE. Cada passo de ferramenta do agente é um pedido ao modelo (o Profundo usa cerca de 15).

## Scope
**In:**
- Tela **"IA da aplicação"** (seção de ⚙ Configurações, só masters): conectar a conta OpenRouter da casa com **"Conectar OpenRouter"** (OAuth PKCE, retorno no nosso domínio) ou colando uma chave; chave cifrada em disco, nunca devolvida (só os 4 últimos caracteres); testar; desconectar; pedidos gratuitos usados hoje.
- **Cadeia de modelos da casa**, editável: por padrão os modelos `:free` com ferramentas da lista ao vivo do OpenRouter (`/api/v1/models`, filtro `:free` + `tools`, atualizada a cada 24 h); `openrouter/free` como última opção gratuita (ligado por padrão); um **modelo pago de reserva** opcional, desligado por padrão.
- **Cota diária de pesquisas por pessoa** (padrão 5, editável pelo master no padrão e por pessoa). Rápido conta 1, Profundo 2, Exaustivo 5.
- **Reserva paga por pessoa** (master, desligada por padrão) com teto mensal em US$, controlado pelo nosso registro e, quando o master informa a chave de gerenciamento do OpenRouter, também por uma chave própria da pessoa com limite mensal no OpenRouter.
- **Política de acesso à IA** (pedido do dono, 2026-10-26): o master escolhe, por pessoa, qual IA da aplicação a atende: "Plano da casa (OpenRouter da aplicação)", "Assinatura Claude da aplicação" (entra no KBC-024) ou "Nenhuma (a pessoa usa a própria IA ou só a busca)", mais um **padrão** para quem não tem escolha e para os próximos convidados. Concede ou revoga para uma pessoa, várias (seleção) ou todas de uma vez. Pode marcar "Usar sempre a IA da aplicação" para uma pessoa. Cada mudança fica no histórico da pessoa (quem, quando, o quê).
- Quem não tem IA própria usa a IA da aplicação atribuída (ou o padrão) sozinho. Cota ou capacidade gratuita esgotada: mensagem clara com "volte amanhã" ou "Conectar a sua própria IA" (abre ⚙ Configurações > IA).
- **Transparência** em toda resposta: modelo que de fato respondeu (o `model` da resposta), "Gratuito" ou o custo, e "Pesquisas restantes hoje: N"; modelo e cobrança guardados no histórico.
- **Produção sem chave de IA no .env:** as chaves e o Claude do PATH só valem por padrão com `KB_CHAT_AI_DEFAULTS=local` (desenvolvimento, recusado em produção); `KB_CHAT_LLM=stub` também é recusado em produção.
- **Segredos cifrados:** chaves de cada pessoa e da casa com AES-256-GCM e a chave mestra `KB_CHAT_SECRETS_KEY` (32 bytes, base64); chaves antigas em texto puro são cifradas na leitura.

**Out:**
- O guia "Sua IA" de cada pessoa, o Gemini e o OAuth do OpenRouter para a própria conta (KBC-023).
- A assinatura do Claude cedida a outras pessoas (KBC-024).
- Cobrar das pessoas ou recarregar créditos pela tela (fica no site do OpenRouter).

## Business rules
- BR-1: só masters veem e mudam "IA da aplicação" e os limites de IA das pessoas; a chave da casa e a de gerenciamento nunca saem do servidor (só `last4`), nunca vão a log nem a resposta.
- BR-2: quem pesquisa com IA é atendido, nesta ordem: (1) a IA da aplicação atribuída, se o master marcou "Usar sempre a IA da aplicação"; (2) a própria IA, se a pessoa configurou e escolheu uma em ⚙ Configurações; (3) a IA da aplicação atribuída à pessoa ou, sem atribuição, o padrão; (4) só em testes, o stub; senão nenhuma (só busca). Em produção, nenhuma variável de ambiente nem o `claude` do PATH escolhem provedor. A pessoa e o master sempre veem qual IA atende e quem paga ("IA da aplicação (cedida pelo administrador)" ou "Sua IA").
- BR-9: o padrão da casa é "Plano da casa" ou "Nenhuma"; a assinatura do Claude nunca é padrão, só por pessoa (KBC-024). "Todos os usuários" aplica a todas as pessoas de hoje e, se pedido, também ao padrão dos futuros.
- BR-3: a cota é por pessoa e por dia (meia-noite do servidor), em pesquisas: Rápido 1, Profundo 2, Exaustivo 5. Sem saldo para o perfil pedido, a pesquisa é recusada antes de chamar o modelo (`HOUSE_QUOTA_EXHAUSTED`). Uma pesquisa que falha antes de qualquer resposta do modelo devolve as pesquisas.
- BR-4: antes de começar, a casa confere os pedidos gratuitos que restam hoje na conta (`GET /api/v1/key`); se faltarem para o perfil (Rápido 8, Profundo 16, Exaustivo 100) e a pessoa não tiver reserva paga, a pesquisa é recusada (`AI_CAPACITY_EXHAUSTED`). Se todos os modelos gratuitos recusarem no meio, o mesmo código encerra a resposta.
- BR-5: o modelo pago só entra na cadeia de uma pessoa com a reserva ligada, e só enquanto o gasto pago dela no mês mais a estimativa da chamada couber no teto mensal. O gasto pago da casa fica num registro separado do gasto com chaves próprias.
- BR-6: a resposta diz o modelo que respondeu (o último que escreveu), "Gratuito" quando custou US$ 0 com modelos gratuitos, senão o custo; e, no plano da casa, quantas pesquisas restam hoje.
- BR-7: chaves em disco só cifradas (AES-256-GCM, IV aleatório por valor); a API não sobe em produção sem `KB_CHAT_SECRETS_KEY` válida; no desenvolvimento, sem a variável, ela cria `<estado>/secrets.key` (0600).
- BR-8: o retorno do OAuth só vale com o `state` emitido para a mesma sessão, em até 10 minutos, uma vez; o verificador PKCE nunca sai do servidor.

## Functional requirements
- FR-1: `GET/PUT /api/v1/house-ai` (master) mostra e altera a configuração da casa (conexão mascarada, cadeia, `openrouter/free`, modelo pago, cota padrão, chave de gerenciamento mascarada, uso gratuito de hoje).
- FR-2: `POST /api/v1/openrouter/connect` (`{ purpose: 'house' }`, master) devolve a URL de autorização com `code_challenge` S256 e `state`; `GET /api/v1/openrouter/callback` troca o código por uma chave em `https://openrouter.ai/api/v1/auth/keys`, grava cifrada e volta para `/?openrouter=connected` (ou `?openrouter=error`).
- FR-3: `GET /api/v1/ai/free-models` lista os modelos gratuitos com ferramentas (id, nome, contexto), atualizada a cada 24 h; uma falha mantém a última lista.
- FR-4: `POST /api/v1/house-ai/test` testa a conta da casa; `DELETE /api/v1/house-ai/key` desconecta.
- FR-5: a pessoa ganha `ai: { appAi, enforced, dailyResearches, paidFallback: { enabled, monthlyCapUsd }, history }`, editável por master em `PATCH /api/v1/people/:id`, na tela "Pessoas e permissões"; `POST /api/v1/people/ai-assignment { personIds | "all", appAi, setDefault? }` atribui a várias ou a todas.
- FR-6: o evento `done` da pesquisa e o turno salvo trazem `billing: 'free'` quando custou zero com modelos gratuitos, `plan: 'house' | 'own'` e, no plano da casa, `remaining`; `GET /api/v1/ai/status` traz o plano ativo e a cota de hoje.
- FR-7: o adaptador do OpenRouter envia a cadeia em `models` (até 3 por pedido, depois a próxima janela) e lê o `model` que respondeu.
- FR-8: `deploy/.env.example`, `deploy.sh` e o runbook exigem `KB_CHAT_SECRETS_KEY`, com o comando de geração na VM.

## Non-functional requirements
- NFR-1: nenhuma chave em texto puro em disco, log ou resposta (teste automatizado lê o arquivo, o log e as respostas).
- NFR-2: nenhuma chamada real a LLM, OpenRouter ou Google nos testes (OpenRouter falso, inclusive no OAuth).
- NFR-3: WCAG 2.2 AA em "IA da aplicação" e nos limites da pessoa, em 1440 e 390 px, sem rolagem horizontal.

## Acceptance criteria
- **AC-1 (FR-2, BR-8)**
  - Given um master em "IA da aplicação" e um OpenRouter falso
  - When ele clica "Conectar OpenRouter", autoriza e volta
  - Then a tela mostra "Conectado ••••wxyz" e o arquivo da casa guarda a chave cifrada
  - And um retorno com `state` desconhecido, vencido ou de outra sessão não grava nada
- **AC-2 (FR-1, BR-1)**
  - Given uma pessoa que não é master
  - When ela chama `/api/v1/house-ai` ou o início do OAuth da casa
  - Then recebe 403, e a seção não aparece para ela
- **AC-3 (FR-3)**
  - Given a lista do OpenRouter com modelos pagos, gratuitos com e sem ferramentas
  - When a casa monta a cadeia padrão
  - Then só entram os `:free` com `tools`, e `openrouter/free` fica por último quando ligado
- **AC-4 (BR-2, FR-6)**
  - Given uma pessoa sem IA própria e a casa conectada
  - When ela pesquisa no Rápido
  - Then a resposta vem do plano da casa, o rodapé mostra o modelo que respondeu, "Gratuito" e "Pesquisas restantes hoje: 4"
  - And o turno salvo guarda o modelo, `billing: 'free'` e `plan: 'house'`
- **AC-5 (BR-3)**
  - Given uma pessoa com cota 2 que já fez uma pesquisa Profunda hoje
  - When ela pede outra (Rápido)
  - Then a pesquisa é recusada com `HOUSE_QUOTA_EXHAUSTED` e a tela oferece esperar até amanhã ou conectar a própria IA
- **AC-6 (BR-4)**
  - Given a conta da casa com 5 pedidos gratuitos restantes hoje
  - When alguém pede uma pesquisa Profunda sem reserva paga
  - Then a pesquisa é recusada com `AI_CAPACITY_EXHAUSTED` e a cota não é gasta
- **AC-7 (BR-5)**
  - Given o modelo pago configurado e uma pessoa com reserva ligada e teto de US$ 1, já com US$ 0,99 gastos no mês
  - When a cadeia da próxima chamada é montada
  - Then o modelo pago fica de fora; com a reserva desligada ele nunca entra
- **AC-8 (FR-5)**
  - Given um master no editor da pessoa
  - When ele muda "Pesquisas por dia" e liga a reserva paga com teto
  - Then a pessoa é salva com esses limites e, com chave de gerenciamento, uma chave com limite mensal é criada para ela no OpenRouter
- **AC-12 (FR-5, BR-9)**
  - Given três pessoas na lista
  - When o master seleciona duas e escolhe "Plano da casa", e depois "Todos os usuários" com "Nenhuma" e "também para os próximos"
  - Then as duas ficam com o plano da casa, depois todas com "Nenhuma", o padrão passa a "Nenhuma" e cada pessoa guarda no histórico quem mudou e quando
- **AC-13 (BR-2)**
  - Given uma pessoa com o plano da casa atribuído e uma chave própria escolhida em Configurações
  - When ela pesquisa
  - Then responde a IA dela ("Sua IA"); com "Usar sempre a IA da aplicação" marcado, responde o plano da casa ("IA da aplicação (cedida pelo administrador)")
- **AC-9 (BR-7, NFR-1)**
  - Given uma chave salva em texto puro antes desta mudança
  - When a API lê as configurações
  - Then o arquivo passa a guardar só o valor cifrado, e nenhuma resposta ou log contém a chave
- **AC-10 (BR-2, BR-7)**
  - Given `NODE_ENV=production`
  - When a API sobe sem `KB_CHAT_SECRETS_KEY`, com `KB_CHAT_AI_DEFAULTS=local` ou com `KB_CHAT_LLM=stub`
  - Then ela recusa a subir com a mensagem do que falta ou do que é proibido
- **AC-11 (BR-2)**
  - Given `OPENROUTER_API_KEY` no ambiente e `KB_CHAT_AI_DEFAULTS` desligado
  - When o dono, sem provedor escolhido, pede uma resposta
  - Then a chave do ambiente não é usada (plano da casa, ou nenhum)

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | integração (`openrouter-connect.integration.test.ts`) + E2E (`house-ai.spec.ts`, OpenRouter falso) | state, verifier, sessão |
| AC-2 | integração + teste de acesso por rota (`route-access.test.ts`) | — |
| AC-3 | unitário (`free-model-catalog.test.ts`) | lista gravada |
| AC-4 | integração (`house-research.integration.test.ts`) + E2E | OpenRouter falso com SSE |
| AC-5, AC-6 | unitário (`house-quota.test.ts`) + integração | — |
| AC-7 | unitário (`house-llm.test.ts`) | — |
| AC-8 | integração (`people` + provisionamento falso) + E2E | — |
| AC-9 | integração (`secrets.integration.test.ts`) | lê arquivo e log |
| AC-10, AC-11 | unitário (`config.test.ts`, `providers.test.ts`) | — |
| AC-12 | unitário (`people-rules`) + integração + E2E (`house-ai.spec.ts`) | — |
| AC-13 | unitário (`ai-access.test.ts`) + integração | — |

## References
ADR: `docs/adr/0016-house-ai-plan-and-access-policy.md` (emenda 0004, 0007, 0008), `docs/adr/0017-secrets-sealed-at-rest.md` · Telas: `docs/design/screens.md` (T6, T9, T12 "IA da aplicação") · Runbook: `docs/deploy/runbook.md` (passo 5)

## Open questions
Nenhuma. Premissas registradas: pesos 1/2/5; reserva de capacidade 8/16/100 pedidos; cota padrão 5; o dia da cota é o do servidor; `openrouter/free` ligado por padrão; o modelo pago só por pessoa.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
