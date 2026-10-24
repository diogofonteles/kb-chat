---
id: KBC-005
title: "Lateral: acervo, histórico da sessão, temas e gasto do dia"
status: ready
slice: release-1
outcome: sessões por semana (retomar uma pesquisa); conforto de leitura
depends_on: [KBC-001, KBC-004]
---

# KBC-005 — Lateral: acervo, histórico da sessão, temas e gasto do dia

## Story

Quando estudo por um tempo, quero trocar de acervo, voltar a perguntas anteriores, escolher o tema visual (inclusive o esotérico) e ver quanto já gastei com IA.

## Scope

**In:**
- Lateral (desktop fixa; celular em gaveta ☰) com "+ Nova conversa".
- Histórico das conversas no navegador ("neste navegador").
- Seletor de Acervo (`GET topics`).
- Tema: Automático, Claro, Escuro ou Esotérico, com tokens DTCG e teste de contraste.
- "Gasto com IA hoje" (`GET spend/today`).

**Out:**
- Histórico entre dispositivos (release 2).

## Business rules

- BR-1: O histórico guarda até 50 conversas no `localStorage` (pergunta, modo, filtros e resultados resumidos, sem corpos de documentos). Acima disso, descarta a mais antiga. Se o storage falhar, o app segue sem histórico.
- BR-2: Trocar de acervo inicia uma conversa nova. O aviso fica inline ("Nova conversa em <Acervo>"), sem modal.
- BR-3: O tema padrão é "Automático" (claro ou escuro pelo sistema). A escolha é lembrada no navegador.
- BR-4: Todo par texto/fundo e acento/fundo de cada tema tem contraste ≥ 4,5:1, e os indicadores de foco ≥ 3:1.

## Functional requirements

- FR-1: Quando o usuário clica em "+ Nova conversa", a web deve limpar a conversa e focar a caixa de pergunta.
- FR-2: Quando o usuário clica numa conversa do histórico, a web deve restaurá-la e refazer a última busca.
- FR-3: Quando o usuário escolhe outro acervo, a web deve iniciar uma conversa nova nesse tópico e atualizar a contagem de documentos (BR-2).
- FR-4: Quando o usuário escolhe um tema, a web deve aplicá-lo sem recarregar a página, via `data-theme` no `<html>` (BR-3).
- FR-5: A web deve mostrar "Gasto com IA hoje: US$ x de US$ y" e atualizar o valor após cada resposta de IA.
- FR-6: No celular, a lateral deve abrir por um botão ☰ rotulado "Menu" e fechar com Esc, com o "×" ou tocando fora dela.

## Non-functional requirements

- NFR-1: teste automatizado de contraste dos três conjuntos de tokens, que falha abaixo dos limites (BR-4).

## Acceptance criteria

- **AC-1 (FR-1)**
  - Given uma conversa com resultados
  - When o usuário clica em "+ Nova conversa"
  - Then a tela volta ao Início com o foco na caixa
- **AC-2 (FR-2, BR-1)**
  - Given 2 conversas no histórico
  - When o usuário clica na primeira
  - Then a pergunta dela reaparece com resultados
- **AC-3 (BR-1, limite)**
  - Given 50 conversas
  - When a 51ª é criada
  - Then a mais antiga sai
- **AC-4 (BR-1, negativo)**
  - Given um `localStorage` que lança erro
  - When o app abre
  - Then a busca funciona e o histórico mostra "indisponível neste navegador"
- **AC-5 (FR-3, BR-2)**
  - Given 2 tópicos na fixture
  - When o usuário troca de acervo
  - Then a conversa é nova e a contagem muda
- **AC-6 (FR-4, BR-3)**
  - Given o tema Esotérico escolhido
  - When a página é recarregada
  - Then `data-theme="esoteric"` continua aplicado
- **AC-7 (BR-4)**
  - Given os tokens light, dark e esoteric
  - When o teste de contraste roda
  - Then todos os pares listados passam
- **AC-8 (FR-5)**
  - Given um gasto de US$ 0,03 no ledger
  - When a lateral aparece
  - Then mostra "US$ 0,03 de US$ 1,00"
- **AC-9 (FR-6)**
  - Given 390 px
  - When o usuário abre o Menu e pressiona Esc
  - Then a gaveta fecha e o foco volta ao botão

## Test strategy

| AC | Nível | Notas |
|---|---|---|
| AC-3, AC-4 | Unit (web: history store) | |
| AC-7 | Unit (web: tokens contrast) | |
| AC-1, AC-2, AC-5, AC-6, AC-8, AC-9 | E2E Playwright | |

## References

- Screen spec: `docs/design/screens.md` (T5; Temas e tokens).
- ADR 0005 (gasto por principal).

## Open questions

Nenhuma.

## Definition of ready

- [x] Story, scope e outcome
- [x] BR/FR cobertos por AC, com negativos
- [x] NFRs mensuráveis
- [x] Nível de teste por AC
- [x] Referências de UI e arquitetura
- [x] Dependências agendadas, sem perguntas abertas
- [x] Cabe num goal
