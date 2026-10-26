---
id: KBC-023
title: "Sua IA: cada pessoa traz a própria IA, com um guia passo a passo na tela"
status: in-review
slice: release-1
outcome: qualquer pessoa conecta a própria IA (OpenRouter em um clique, Gemini gratuito, Claude ou OpenAI pela API) sem ajuda, sabendo quanto custa, o que é compartilhado e quem paga
depends_on: [KBC-007, KBC-022]
---

# KBC-023 — Sua IA: guia na tela para trazer a própria IA

## Story
Como pessoa convidada, quero conectar a minha própria IA seguindo um guia dentro da Nova Alexandria, para pesquisar sem depender da cota da aplicação e saber o que estou pagando e o que estou compartilhando.

Decisão do dono em 2026-10-26: tudo pela UI. Pesquisa do mesmo dia: o OpenRouter permite conectar a conta da pessoa por OAuth PKCE (a aplicação recebe uma chave controlada por ela); a chave do Google AI Studio tem plano gratuito do Gemini com chamada de funções (os dados do plano gratuito podem ser usados pelo Google); a Anthropic proíbe usar as assinaturas Free/Pro/Max em produtos de terceiros (The Register, 2026-02-20) e o "Entrar com ChatGPT" com o plano da pessoa não está aberto (lançado em 2026-09-29 só para parceiros): Claude e OpenAI só por chave de API.

## Scope
**In:**
- ⚙ Configurações > **IA** vira **"Sua IA"**, um guia: o cartão "Quem atende você" (IA ativa, resultado do último teste, uso e custo de hoje) e as opções, cada uma com passos numerados em pt-BR, custo, privacidade, limites e links diretos:
  1. **IA da aplicação** (voltar a ela a qualquer momento);
  2. **OpenRouter**: "Conectar OpenRouter" (OAuth PKCE, `purpose: own`) ou colar a chave; modelos gratuitos (a mesma lista ao vivo, filtrada por ferramentas) e reserva paga opcional com teto mensal da própria pessoa;
  3. **Gemini (gratuito)**: novo provedor `gemini`, com o link para criar a chave no Google AI Studio, colar, "Testar conexão" e o plano (gratuito / pago);
  4. **Claude (API da Anthropic)** e **OpenAI (API)**: chave com guia; aviso de que assinaturas (Claude Pro/Max, ChatGPT Plus) não podem ser conectadas.
- `GeminiAdapter`: API REST oficial (`streamGenerateContent?alt=sse`, `x-goog-api-key`), streaming, chamada de funções no loop por token com as ferramentas e o registro de gasto; assinaturas de pensamento devolvidas sem mudança.
- As mensagens "sem IA" e "cota esgotada" (KBC-022) levam ao guia.

**Out:**
- Assinaturas pessoais (Claude, ChatGPT) para convidados (KBC-024, KBC-027).
- Outros provedores (Mistral, DeepSeek direto, Vertex AI).
- Teto mensal próprio separado do limite diário (o limite diário já existe e vale para a reserva paga).

## Business rules
- BR-1: a própria IA, escolhida pela pessoa, atende antes da IA da aplicação, salvo se o master marcou "Usar sempre a IA da aplicação" (ADR 0016); a pessoa volta à IA da aplicação quando quiser ("IA da aplicação" no guia).
- BR-2: a conexão do OpenRouter por OAuth só vale para quem tem "Configurações de IA próprias"; a chave recebida fica cifrada nas configurações da pessoa (ADR 0017) e nunca volta à tela (só os 4 últimos caracteres).
- BR-3: no OpenRouter, o padrão de uma conexão nova é **"Só modelos gratuitos"** (custo zero): a mesma lista ao vivo do KBC-022, filtrada por ferramentas, e `openrouter/free` por último. A pessoa pode escolher os modelos ou passar para "Modelo à escolha" (os modelos rápido e profundo de antes). Um modelo pago de reserva opcional entra no fim da lista só enquanto o gasto do dia dela mais a estimativa couber no seu limite diário (US$).
- BR-4: o Gemini tem o plano "Gratuito" (padrão; custo US$ 0, com o aviso de que o Google pode usar os dados do plano gratuito) ou "Pago" (custo pela tabela do Google, dentro do limite diário).
- BR-5: Claude e ChatGPT só por chave de API; a tela diz que as assinaturas (Claude Pro/Max, ChatGPT Plus/Pro) não podem ser conectadas por terceiros.
- BR-6: o cartão "Quem atende você" mostra a IA ativa, quem paga, o resultado do último teste (com a data) e o uso de hoje: pesquisas restantes (IA da aplicação), "Gratuito" (modelos gratuitos, Gemini gratuito) ou o gasto de hoje e o limite.
- BR-7: as respostas dizem "Gratuito" quando custaram US$ 0 com modelos gratuitos (OpenRouter `:free`/`openrouter/free`, Gemini gratuito), também na IA própria.

## Functional requirements
- FR-1: `POST /api/v1/openrouter/connect { purpose: 'own' }` (pessoa com `own-ai-settings`) e o mesmo retorno do KBC-022 gravam a chave em `settings.ai.keys.openrouter` e escolhem o OpenRouter; a tela volta em ⚙ > IA com "Conta conectada.".
- FR-2: novo provedor `gemini` no contrato (`AI_PROVIDERS`, chave própria, modelos rápido/profundo) e `GeminiAdapter` (REST `streamGenerateContent?alt=sse`, `x-goog-api-key`, `functionDeclarations` com `parametersJsonSchema`, `toolConfig` AUTO/NONE, `functionResponse` com `id` e `name`, partes do modelo devolvidas sem mudança); 429 vira falta de capacidade do provedor, chave inválida vira `LLM_KEY_REJECTED`.
- FR-3: `settings.ai.openrouter = { mode: 'free' | 'models', freeModels, includeRouter, paidModel }` e `settings.ai.gemini = { tier: 'free' | 'paid' }`; `settings.ai.lastTest = { provider, ok, code, at }` gravado por "Testar conexão".
- FR-4: `GET /api/v1/ai/status` ganha `spentTodayUsd`, `dailyCapUsd`, `free` e `lastTest`.
- FR-5: ⚙ > IA vira o guia "Sua IA": cartão de status e um cartão por opção com passos numerados, custo, privacidade, limites e links diretos; o assistente de primeira abertura usa o mesmo guia, compacto.

## Non-functional requirements
- NFR-1: nenhuma chamada real a OpenRouter, Google, Anthropic ou OpenAI nos testes (servidores falsos, inclusive o OAuth).
- NFR-2: WCAG 2.2 AA no guia, em 1440 e 390 px, sem rolagem horizontal; os links externos abrem em nova aba com aviso no nome acessível.
- NFR-3: nenhuma chave em resposta, log ou disco em texto puro (ADR 0017).

## Acceptance criteria
- **AC-1 (FR-1, BR-2)**
  - Given uma pessoa com "Configurações de IA próprias" em ⚙ > IA > OpenRouter
  - When ela clica "Conectar OpenRouter" e autoriza (OpenRouter falso)
  - Then volta com "Conta conectada.", o cartão mostra "Sua IA · OpenRouter · Só modelos gratuitos" e a chave fica só cifrada
  - And uma pessoa sem a funcionalidade recebe 403 ao iniciar a conexão
- **AC-2 (BR-3, BR-7)**
  - Given o OpenRouter próprio em "Só modelos gratuitos"
  - When a pessoa pesquisa
  - Then o pedido vai com a lista gratuita em `models` e o rodapé diz "Sua IA · Respondido por <modelo> · Gratuito"
- **AC-3 (BR-3)**
  - Given um modelo pago de reserva e o limite diário de US$ 0,01 já gasto
  - When a próxima chamada é montada
  - Then o modelo pago fica fora da lista
- **AC-4 (FR-2, BR-4)**
  - Given uma chave do Gemini válida no plano Gratuito
  - When a pessoa testa e pesquisa
  - Then o teste diz "Conexão funcionando", a pesquisa usa as ferramentas do acervo e o rodapé diz "Gratuito"; uma chave inválida mostra "A chave não foi aceita pelo provedor"
- **AC-5 (FR-2)**
  - Given o Gemini pedindo uma ferramenta com `thoughtSignature`
  - When o resultado volta
  - Then a próxima chamada leva a parte do modelo idêntica e um `functionResponse` com o mesmo `id` e `name`
- **AC-6 (BR-5, FR-5)**
  - Given o guia "Sua IA"
  - When a pessoa abre Claude ou OpenAI
  - Then vê os passos para criar a chave de API, o custo e o aviso de que a assinatura não pode ser conectada
- **AC-7 (BR-6, FR-4)**
  - Given a própria IA com um teste bem-sucedido e US$ 0,02 gastos hoje
  - When a pessoa abre ⚙ > IA
  - Then o cartão mostra a IA, "você paga", "Último teste: funcionando (dd/mm hh:mm)" e "Gasto hoje: US$ 0,02 de US$ 1,00"
- **AC-8 (BR-1)**
  - Given uma pessoa com a própria IA escolhida
  - When ela escolhe "IA da aplicação" e salva
  - Then a próxima pesquisa usa a IA da aplicação e o cartão diz "IA da aplicação (cedida pelo administrador)"
- **AC-9 (KBC-022)**
  - Given a cota esgotada
  - When a pessoa clica "Conectar a minha IA"
  - Then ⚙ > IA abre no guia

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | integração (`own-ai.integration.test.ts`) + E2E (`own-ai.spec.ts`) | OpenRouter falso |
| AC-2, AC-3 | unitário (`provider-registry`, `house-llm`) + integração | — |
| AC-4, AC-5 | unitário (`gemini-adapter.test.ts`) + E2E (Gemini falso) | respostas gravadas |
| AC-6, AC-7, AC-8 | unitário web (`own-ai-guide.spec.ts`, `ai-status-card.spec.ts`) + E2E | — |
| AC-9 | E2E (`house-ai.spec.ts`) | — |

## References
ADR: `docs/adr/0018-own-ai-gemini-and-free-openrouter.md` (emenda 0007, 0016) · Telas: `docs/design/screens.md` (T6 "Sua IA") · Pesquisa: The Register 2026-02-20; openrouter.ai/docs (OAuth, limits, fallbacks); ai.google.dev (pricing, function calling, thought signatures).

## Open questions
Nenhuma. Premissas: OpenRouter conectado começa em "Só modelos gratuitos"; o limite do modelo pago próprio é o limite diário já existente; o Gemini começa no plano Gratuito.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
