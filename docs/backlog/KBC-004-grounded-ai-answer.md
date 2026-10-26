---
id: KBC-004
title: Responder com IA citando as fontes
status: done
slice: release-1
outcome: % de buscas que pedem IA (< 30%); gasto/dia ≤ teto
depends_on: [KBC-001]
---

# KBC-004 — Responder com IA citando as fontes

## Story

Quando os resultados não bastam para entender o assunto, quero pedir uma resposta escrita a partir do acervo, sabendo antes quanto custa e de onde veio cada afirmação.

## Scope

**In:**
- Botão "Responder com IA · ~US$ x", com estimativa e resposta em streaming (SSE): etapas, citações [n] que abrem o painel, lista de "Fontes" e custo real.
- Botão "Parar".
- Teto diário, ledger de gasto e verificação de saldo OpenRouter.
- Estados de erro de `screens.md` (T4).

**Out:**
- Conversa multi-turno.
- "Resposta profunda" com `kb find` (release 2).

## Business rules

- BR-1: A IA só roda por clique explícito; nada dispara sozinho.
- BR-2: Antes da chamada, a API estima o custo com os tokens das passagens + a pergunta + a saída máxima (800 tokens), pelo preço do modelo. O botão mostra a estimativa arredondada para cima em centavos de dólar.
- BR-3: A API recusa (`DAILY_CAP_REACHED`) quando o gasto do dia + a estimativa > `KB_CHAT_DAILY_CAP_USD` (padrão 1,00). O dia segue o fuso local.
- BR-4: A resposta usa no máximo 8 passagens dos resultados atuais, com os filtros ativos, cada uma com o resumo do documento e até 2.500 caracteres (revisado em 2026-10-24, ADR 0004). Cada afirmação traz [n], e [n] corresponde à fonte n listada.
- BR-5: Sem base nas passagens, a resposta diz que o acervo não traz informação suficiente e sugere outra busca.
- BR-6: Cada resposta concluída ou interrompida grava `{ts, principal, model, inputTokens, outputTokens, usd}` no ledger `~/.kb-chat/spend.jsonl`. O custo real vem do `usage` da resposta do OpenRouter.
- BR-7: A chave da OpenRouter só existe no servidor (env) e nunca aparece em resposta nem em log.

## Functional requirements

- FR-1: Quando há resultados, a web deve mostrar o botão com a estimativa obtida de `POST answers/estimates` (BR-1, BR-2).
- FR-2: Quando o usuário clica no botão, a web deve enviar `POST answers` com `Idempotency-Key` e mostrar as etapas "Escolhendo trechos…" e "Escrevendo resposta…", com "Parar" disponível.
- FR-3: A API deve transmitir eventos SSE `step`, `token`, `citations` e `done` (este com `{usd, model}`) ou `error` (`{code}`).
- FR-4: Quando chega um [n], a web deve renderizá-lo como botão que abre o painel do documento n.
- FR-5: Ao concluir, a web deve mostrar "Fontes" (títulos clicáveis), "Custo: US$ x" e o rodapé "Resposta gerada por IA a partir do acervo; confira nas fontes."
- FR-6: Quando o usuário clica em "Parar", a API deve abortar a chamada e gravar o custo parcial; a web deve marcar "(interrompida)".
- FR-7: Sem `OPENROUTER_API_KEY`, o botão deve ficar desabilitado com a explicação de `screens.md` (`LLM_NOT_CONFIGURED`).
- FR-8: Quando o saldo da conta OpenRouter (total_credits − total_usage, em cache de 60 s) for menor que a estimativa, a API deve responder `LLM_INSUFFICIENT_CREDIT` (BR-3).
- FR-9: A API deve repetir a mesma resposta (sem nova cobrança) para um `Idempotency-Key` repetido em até 10 minutos.

## Non-functional requirements

- NFR-1: o primeiro token chega em ≤ 5 s e a resposta completa em p95 ≤ 20 s, com o modelo padrão (medido manualmente em 5 perguntas reais, registrado na validação local).
- NFR-2: custo médio ≤ US$ 0,02 por resposta (medido no ledger após 5 perguntas).

## Acceptance criteria

- **AC-1 (FR-1, BR-2)**
  - Given resultados e o preço do modelo stub de US$ 1/M tokens
  - When a lista aparece
  - Then o botão mostra "~US$ 0,01"
- **AC-2 (BR-1)**
  - Given uma busca concluída
  - When nenhum clique ocorre
  - Then nenhuma requisição ao LLM é feita
- **AC-3 (FR-2–FR-5, BR-4)**
  - Given um LLM stub que responde "A natureza é sétupla [1]."
  - When o usuário pede a resposta
  - Then ela aparece com [1] clicável, "Fontes" lista o doc 1 e o custo é exibido
- **AC-4 (BR-4)**
  - Given 12 resultados
  - When a API monta o prompt
  - Then só 8 passagens, cada uma com resumo e ≤ 2.500 caracteres, são enviadas
- **AC-5 (BR-3, negativo)**
  - Given um gasto do dia de US$ 0,995 com teto de US$ 1,00 e uma estimativa de US$ 0,01
  - When o usuário pede a resposta
  - Then a API responde `DAILY_CAP_REACHED`
  - And a web mostra a mensagem de limite
- **AC-6 (FR-7, negativo)**
  - Given a API sem chave
  - When a lista aparece
  - Then o botão fica desabilitado com a explicação
- **AC-7 (FR-8)**
  - Given o saldo stub de US$ 0
  - When o usuário pede a resposta
  - Then aparece a mensagem de créditos esgotados com o link
- **AC-8 (FR-6, BR-6)**
  - Given uma resposta em andamento
  - When o usuário clica em "Parar"
  - Then o texto parcial fica com "(interrompida)"
  - And o ledger ganha uma linha
- **AC-9 (FR-9)**
  - Given um `Idempotency-Key` repetido
  - When a API recebe o segundo POST
  - Then não há nova chamada ao LLM nem nova linha no ledger
- **AC-10 (BR-7, negativo)**
  - Given a chave definida
  - When os logs e as respostas de todas as rotas são inspecionados nos testes
  - Then a chave não aparece
- **AC-11 (BR-5)**
  - Given o LLM stub respondendo "O acervo não traz informação suficiente"
  - When a resposta termina
  - Then a web mostra a sugestão de outra busca

## Test strategy

| AC | Nível | Notas |
|---|---|---|
| AC-4, AC-5, AC-9, AC-10 | Unit/integração (api: answers) | `LlmPort` stub, ledger em pasta temporária |
| AC-1–AC-3, AC-6–AC-8, AC-11 | E2E Playwright | `KB_CHAT_LLM=stub` |
| NFR-1, NFR-2 | Validação local manual com a OpenRouter real (custo < US$ 0,10) | |

## References

- Screen spec: `docs/design/screens.md` (T4).
- ADR 0004.

## Open questions

Nenhuma. O teto padrão de US$ 1 foi assumido no brief e é configurável.

## Definition of ready

- [x] Story, scope e outcome
- [x] BR/FR cobertos por AC, com negativos
- [x] NFRs mensuráveis
- [x] Nível de teste por AC
- [x] Referências de UI e arquitetura
- [x] Dependências agendadas, sem perguntas abertas
- [x] Cabe num goal
