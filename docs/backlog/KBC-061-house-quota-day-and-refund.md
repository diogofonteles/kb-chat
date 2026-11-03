---
id: KBC-061
title: "Cota diária da IA da aplicação: o dia no horário do Recife, estorno quando a pesquisa falha e \"Tentar de novo\" quando a cota volta"
status: done
slice: phase-2-a
outcome: ninguém perde a cota do dia por uma pesquisa que falhou nem fica bloqueado de manhã por uma pesquisa feita na noite anterior
depends_on: []
---

# KBC-061 — Cota diária da IA da aplicação

## Story
Como quem pesquisa com a IA da aplicação, quero que a cota do dia volte à meia-noite do Recife e que uma pesquisa que falhou sem resposta não gaste a cota, para não ficar dias sem conseguir perguntar.

## Contexto (relato do Mariano, 03/11/2026)
"Suas pesquisas com IA de hoje acabaram (5 por dia)" desde uma pesquisa exaustiva, mesmo no Rápido e no Profundo, por dois dias. Causa comprovada em produção (leitura): o dia virava à meia-noite UTC (21h no Recife); as duas exaustivas dele terminaram em erro do provedor depois de começar e gastaram as 5 unidades cada, sem estorno; a conversa mostrava o erro salvo sem "Tentar de novo".

## Scope
**In:** dia e mês do app no horário do Recife (cota da IA da casa, teto mensal do plano, gasto do dia); estorno quando a pesquisa termina em erro sem nenhum texto de resposta; "Tentar de novo" depois de "Suas pesquisas com IA de hoje acabaram".
**Out:** a causa das falhas do provedor nas exaustivas (investigação à parte); fuso por pessoa.

## Business rules
- BR-1: "hoje" e "este mês" do app são os do Recife (America/Recife), seja qual for o fuso do servidor.
- BR-2: uma pesquisa que termina em erro sem ter escrito nenhuma parte da resposta não gasta a cota; com parte da resposta escrita, gasta.

## Functional requirements
- FR-1: a cota da IA da casa, o teto mensal do plano e o gasto do dia devem contar a partir da meia-noite do Recife. (BR-1)
- FR-2: o runner da casa deve devolver as unidades quando o turno termina em erro antes do primeiro texto da resposta, mesmo depois de passos e fontes. (BR-2)
- FR-3: a mensagem de cota esgotada deve oferecer "Tentar de novo" (o servidor responde de novo; se a cota voltou, a pesquisa segue).

## Acceptance criteria
- **AC-1** (FR-1): Given uma exaustiva às 22:06 no Recife (01:06 UTC do dia seguinte), When a pessoa pergunta às 09:34 do dia seguinte no Recife, Then tem as 5 pesquisas.
- **AC-2** (FR-1): Given uma pesquisa às 23:59 no Recife, When a pessoa pergunta às 00:01, Then a cota do novo dia vale.
- **AC-3** (FR-2): Given uma exaustiva que trabalhou (passos, fontes) e falhou sem resposta, When a pessoa pergunta de novo, Then a cota está inteira.
- **AC-4** (FR-2): Given uma pesquisa que escreveu parte da resposta e falhou, Then a unidade fica gasta.
- **AC-5** (FR-3): Given a mensagem de cota esgotada, Then aparece "Tentar de novo".

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2 | unitário (`app-calendar`, `house-quota`) | rodado com o processo em UTC, Recife e Tóquio |
| AC-3, AC-4 | unitário (`house-runner`) | |
| AC-5 | componente (`research-message`) | |

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done; no open questions
- [x] Fits one goal
