---
id: KBC-130
title: "Redesign v2: Preparar, Faixas e Limites — passos com stepper, editor com a onda e barra de aprovar"
status: ready
slice: ui-v2-areas
outcome: quem prepara uma gravação entende em que passo está e aprova faixas sem erro
depends_on: [KBC-125]
---

# KBC-130 — Preparar, Faixas e Limites v2

## Story
Como quem prepara uma gravação, quero ver em que passo estou, editar as faixas sobre a onda do áudio e aprovar com uma barra clara, para publicar sem errar.

## Scope
**In:** os 14 estados de v2 · Mídia — Preparar, Faixas e Limites: stepper com os rótulos da v1; escolha do que fazer; nada a preparar; sem permissão; etapas de processamento; editor de faixas com a onda (668×64), ferramentas compactas e linhas de 46; correções; limites com início e fim e "Desfazer"; barra de aprovar fixa no rodapé; erros e sobreposição.
**Out:** regras de faixas e correções (iguais à v1).

## Business rules
- BR-1: a área mantém toda a informação e todas as ações da v1; mudam a forma, a hierarquia e o padrão de interação (docs/design/redesign-v2.md). Nenhuma ação sai sem decisão do dono.
- BR-2: regra de áudio: player, mini player, Biblioteca de mídia, Fila de processamento, Meus marcadores, o chip "Áudios" e os cartões de ouvir só aparecem quando o acervo em uso tem áudio ou algo está tocando.
- BR-3: cada estado existe em desktop (≥ 1024 px, desenhado em 1440) e celular (< 1024 px, desenhado em 390), conforme o par de frames `id` / `id@mobile` da página v2.
- BR-4: as validações de faixas da v1 (sobreposição, campos obrigatórios, KBC-094 e KBC-095) continuam iguais; só a apresentação muda.

## Functional requirements
- FR-1: o stepper deve mostrar o passo atual, os concluídos e os seguintes, com os rótulos da v1. (BR-1)
- FR-2: o editor deve mostrar a onda com as faixas sobre ela, e clicar numa faixa seleciona a linha correspondente (e o contrário).
- FR-3: a barra de aprovar deve ficar fixa no rodapé sem cobrir a última linha, mostrando o motivo quando aprovar estiver bloqueado. (BR-4)

## Non-functional requirements
- NFR-1: nenhuma violação séria ou crítica do axe nos estados da área, em 1440 e 390, nos quatro temas.
- NFR-2: INP ≤ 200 ms nas interações da área (abrir menu, folha, filtro, modal), medido no E2E com o perfil de desempenho do Chrome.
- NFR-3: os E2E existentes da área continuam verdes (atualizados para o novo DOM, sem afrouxar asserções) e a cobertura não cai do piso de 80%.

## Acceptance criteria
- AC-1 (FR-1): Given a preparação no passo 2, When a tela abre, Then o stepper marca o passo 1 como feito e o 2 como atual, com os rótulos da v1.
- AC-2 (FR-2): Given 3 faixas, When a pessoa clica a segunda na onda, Then a linha 2 fica selecionada e visível.
- AC-3 (FR-3, BR-4): Given duas faixas sobrepostas, When a pessoa tenta aprovar, Then a barra mostra o motivo e as faixas em conflito ficam marcadas, como na v1.
- AC-4 (FR-3): Given a última linha do editor, When rola até o fim, Then ela fica inteira acima da barra de aprovar (1440 e 390).
- AC-5 (estados): Given sem permissão, nada a preparar e os limites com "Desfazer", When renderizam, Then batem com os frames e "Desfazer" volta o limite anterior.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-5 | E2E + captura | |
| AC-2 | componente + E2E | |
| AC-3 | E2E | Regras da v1 |
| AC-4 | E2E | 1440 e 390 |

## References
Figma: [v2 · Mídia — Preparar, Faixas e Limites](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=373-2) · Plano: `docs/design/redesign-v2.md` · Telas v1: T20 "Preparar áudio" · KBC-066, KBC-068, KBC-073, KBC-094, KBC-095

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
