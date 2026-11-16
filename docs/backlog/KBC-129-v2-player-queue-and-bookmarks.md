---
id: KBC-129
title: "Redesign v2: player como \"Tocando agora\" expandido, painel direito, Fila de processamento e Meus marcadores"
status: ready
slice: ui-v2-areas
outcome: quem ouve acompanha a transcrição, as vozes e as faixas num só lugar, e o que está processando fica visível
depends_on: [KBC-125]
---

# KBC-129 — Player, Fila e Marcadores v2

## Story
Como quem ouve uma aula, quero o player com a capa, a transcrição grande e as vozes e faixas à mão, e um painel "Tocando agora" ao lado de qualquer tela, para acompanhar e marcar sem perder o lugar.

## Scope
**In:** os 19 estados de v2 · Mídia — Player (cabeçalho com capa, play, voltar/avançar, velocidade, marcador, compartilhar como ícone só quando o KBC-136 existir, ⋯; transcrição com a fala atual em destaque e a palavra acesa; vistas Transcrição · Vozes · Faixas em chips; marcas; timer; não encontrada e falha) e o mini player; painel direito "Tocando agora" (capa, título, cartão da transcrição, "Sobre a autora") aberto pela barra do player; os 4 estados de v2 · Mídia — Fila e Marcadores (Fila de processamento com itens e vazia; Meus marcadores com itens e vazio).
**Out:** fila de escuta "A seguir" (KBC-053, que usa a aba Fila do painel); "Seguir" a autora (KBC-135; o botão só aparece com ele).

## Business rules
- BR-1: a área mantém toda a informação e todas as ações da v1; mudam a forma, a hierarquia e o padrão de interação (docs/design/redesign-v2.md). Nenhuma ação sai sem decisão do dono.
- BR-2: regra de áudio: player, mini player, Biblioteca de mídia, Fila de processamento, Meus marcadores, o chip "Áudios" e os cartões de ouvir só aparecem quando o acervo em uso tem áudio ou algo está tocando.
- BR-3: cada estado existe em desktop (≥ 1024 px, desenhado em 1440) e celular (< 1024 px, desenhado em 390), conforme o par de frames `id` / `id@mobile` da página v2.
- BR-4: o painel "Tocando agora" mostra só dados já existentes (mídia, autora, transcrição, outras mídias da autora no acervo); botões de funções que ainda não existem não aparecem.

## Functional requirements
- FR-1: o player deve seguir `media-player` (Telas-chave) com a fala atual em destaque e a palavra acesa sincronizada como na v1 (KBC-038). (BR-1)
- FR-2: o botão de transcrição da barra do player deve abrir e fechar o painel "Tocando agora" em qualquer tela; no celular, o mini player abre o player em tela cheia. (BR-2, BR-3)
- FR-3: as vistas Vozes e Faixas devem manter as ações da v1 (renomear voz, ir à faixa). (BR-1)
- FR-4: a Fila de processamento e Meus marcadores devem seguir os frames, com as mesmas ações (abrir, tentar de novo, remover marcador).

## Non-functional requirements
- NFR-1: nenhuma violação séria ou crítica do axe nos estados da área, em 1440 e 390, nos quatro temas.
- NFR-2: INP ≤ 200 ms nas interações da área (abrir menu, folha, filtro, modal), medido no E2E com o perfil de desempenho do Chrome.
- NFR-3: os E2E existentes da área continuam verdes (atualizados para o novo DOM, sem afrouxar asserções) e a cobertura não cai do piso de 80%.
- NFR-4: a fala atual acompanha o áudio com atraso ≤ 250 ms (medido no E2E com áudio de 5 s gerado por ffmpeg).

## Acceptance criteria
- AC-1 (FR-1): Given uma mídia com transcrição tocando em 0:22, When o player abre, Then a fala de 0:22 está em destaque e a palavra atual acesa, como no frame (captura).
- AC-2 (FR-2): Given a Biblioteca com algo tocando, When a pessoa clica o botão de transcrição da barra do player, Then o painel "Tocando agora" abre à direita e a tabela estreita sem cortar colunas.
- AC-3 (FR-2): Given 390 px, When a pessoa toca no mini player, Then o player abre em tela cheia e o som não para.
- AC-4 (BR-4, negativo): Given que o KBC-135 não existe, When o painel abre, Then não há botão "Seguir".
- AC-5 (FR-3): Given a vista Vozes, When a pessoa renomeia "Voz 1" para "Sérgio Andrade", Then a transcrição mostra o nome novo, como na v1.
- AC-6 (FR-4, estados): Given a Fila com um item que falhou, e Meus marcadores vazio, When renderizam, Then batem com os frames e "Tentar de novo" funciona.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | E2E + captura | Áudio de fixture com transcrição |
| AC-2, AC-3 | E2E | Conta elementos de mídia |
| AC-4 | componente | |
| AC-5 | E2E | Fluxo da v1 |
| AC-6 | E2E + captura | Estados semeados |
| NFR-4 | E2E com medição | |

## References
Figma: [v2 · Telas-chave](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=367-2) (Player), [v2 · Mídia — Player](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=371-2), [v2 · Mídia — Fila e Marcadores](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=370-2) · Plano: `docs/design/redesign-v2.md` · Telas v1: T15, T23 · KBC-038, KBC-041, KBC-046, KBC-064

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
