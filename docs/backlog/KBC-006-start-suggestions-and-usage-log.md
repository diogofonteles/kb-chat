---
id: KBC-006
title: Sugestões iniciais de assunto e log de uso local
status: in-progress
slice: release-1
outcome: primeira busca sem esforço; medição das métricas do brief
depends_on: [KBC-002]
---

# KBC-006 — Sugestões iniciais de assunto e log de uso local

## Story

1. Ao abrir o app sem saber por onde começar, quero ver os principais assuntos do acervo como sugestões clicáveis.
2. Como dono do produto, quero que o uso fique registrado localmente para medir as métricas do brief.

## Scope

**In:**
- Até 6 sugestões no Início: os maiores Assuntos, via `GET facets`.
- Log JSONL local de eventos e o script `pnpm --filter api usage-report`.

**Out:**
- Painel de analytics na UI.

## Business rules

- BR-1: As sugestões são os 6 conceitos com mais documentos no acervo atual (nome normalizado, BR-5 de KBC-002). O clique busca o nome do assunto com o filtro "Assuntos: <nome>".
- BR-2: Os eventos gravados são `search` (modo, nº de filtros, total, tookMs), `filter`, `open_doc` (posição), `ai_answer` (usd) e `ai_cancel`. Cada evento leva `ts`, `principal` e `sessionId`. O texto da pergunta é gravado só localmente. Nada sai do Mac.
- BR-3: Os eventos com mais de 90 dias são removidos na inicialização da API (retenção do plano de pesquisa).
- BR-4: O relatório mostra, por semana: sessões, % de buscas com documento aberto, % de buscas com IA, % de sessões com filtro e gasto, ou seja, as métricas do brief e do plano de pesquisa.

## Functional requirements

- FR-1: Quando o Início é exibido, a web deve mostrar as sugestões do BR-1 como botões.
- FR-2: Quando o usuário clica numa sugestão, a web deve enviar a busca com o filtro de assunto.
- FR-3: A web deve enviar os eventos do BR-2 para `POST /api/v1/events` (fire-and-forget; falha silenciosa sem afetar a UI). A API deve validá-los e anexá-los a `~/.kb-chat/events.jsonl`.
- FR-4: `pnpm --filter api usage-report` deve imprimir a tabela semanal do BR-4.
- FR-5: A API deve aplicar a retenção do BR-3 ao iniciar.

## Non-functional requirements

Nenhum além da definição de pronto global.

## Acceptance criteria

- **AC-1 (FR-1, BR-1)**
  - Given uma fixture com 8 conceitos
  - When o Início abre
  - Then aparecem os 6 com mais documentos, em ordem
- **AC-2 (FR-2)**
  - Given a sugestão "Cabala"
  - When o usuário clica nela
  - Then a busca roda com o filtro "Assuntos: Cabala" ativo
- **AC-3 (FR-3, BR-2)**
  - Given uma busca seguida da abertura de um documento
  - When o log é lido
  - Then contém `search` e `open_doc` com o mesmo `sessionId`
- **AC-4 (FR-3, negativo)**
  - Given `POST events` respondendo 500
  - When o usuário busca
  - Then a UI não mostra erro
- **AC-5 (BR-3)**
  - Given um evento de 91 dias
  - When a API inicia
  - Then o evento é removido
  - And o evento de 89 dias permanece
- **AC-6 (FR-4, BR-4)**
  - Given um log de fixture
  - When o relatório roda
  - Then as porcentagens batem com os valores esperados

## Test strategy

| AC | Nível | Notas |
|---|---|---|
| AC-3, AC-5, AC-6 | Unit/integração (api: usage) | pasta temporária |
| AC-1, AC-2, AC-4 | E2E Playwright | |

## References

- Screen spec: `docs/design/screens.md` (T1).
- Plano de pesquisa: `docs/research/2026-10-23-search-habit.md`.

## Open questions

Nenhuma.

## Definition of ready

- [x] Story, scope e outcome
- [x] BR/FR cobertos por AC, com negativos
- [x] NFRs mensuráveis (nenhum além do global)
- [x] Nível de teste por AC
- [x] Referências de UI e arquitetura
- [x] Dependências agendadas, sem perguntas abertas
- [x] Cabe num goal
