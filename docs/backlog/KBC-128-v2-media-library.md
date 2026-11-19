---
id: KBC-128
title: "Redesign v2: Biblioteca de mídia — cabeçalho com capa, tabela de faixas, cartões de atenção, grade e seleção"
status: ready
slice: ui-v2-areas
outcome: quem estuda por áudio acha, retoma e organiza as gravações como num app de música
depends_on: [KBC-125]
---

# KBC-128 — Biblioteca de mídia v2

## Story
Como quem estuda por áudio, quero a Biblioteca como uma playlist (capa, play verde, tabela das mídias, o que precisa de atenção em destaque), para retomar e organizar as gravações sem procurar.

## Scope
**In:** os 27 estados de v2 · Mídia — Biblioteca e lista: cabeçalho com capa e barra de ações (play, aleatório quando houver, enviar, convidar, ⋯, busca, Ordenar e Ver como); tabela (# · capa + título/autor · situação · duração · ⋯) com tocando em verde; "Precisa da sua atenção" com ação direta; filtros em chips (autoria, situação, assuntos) e menus; grade; seleção com a barra de ações (barra inferior no celular); busca com e sem resultado; vazios; envio e edição em modal; menus de contexto; painel direito estreitando a tabela.
**Out:** Favoritas, playlists, pastas e página do autor (KBC-052, 054, 055, 059: cada uma traz a sua tela na v2).

## Business rules
- BR-1: a área mantém toda a informação e todas as ações da v1; mudam a forma, a hierarquia e o padrão de interação (docs/design/redesign-v2.md). Nenhuma ação sai sem decisão do dono.
- BR-2: regra de áudio: player, mini player, Biblioteca de mídia, Fila de processamento, Meus marcadores, o chip "Áudios" e os cartões de ouvir só aparecem quando o acervo em uso tem áudio ou algo está tocando.
- BR-3: cada estado existe em desktop (≥ 1024 px, desenhado em 1440) e celular (< 1024 px, desenhado em 390), conforme o par de frames `id` / `id@mobile` da página v2.
- BR-4: as ações de cada mídia (tocar, editar, preparar, transcrever de novo, remover, nível) seguem as permissões e os níveis da v1 (KBC-105).

## Functional requirements
- FR-1: a tabela deve mostrar as mesmas colunas de dados da v1, com o item tocando em verde e o menu ⋯ com as mesmas ações. (BR-1, BR-4)
- FR-2: "Precisa da sua atenção" deve listar as mídias com pendência (falha, aguardando transcritor, preparação parada, faixas a validar) com a ação direta de cada uma. (BR-1)
- FR-3: Ordenar e Ver como (lista, grade) devem abrir em menu no desktop e folha no celular, e a escolha deve persistir na conta. (BR-3)
- FR-4: com itens selecionados, a barra de seleção deve oferecer as ações em lote da v1; no celular, ela substitui a navegação inferior. (BR-3)

## Non-functional requirements
- NFR-1: nenhuma violação séria ou crítica do axe nos estados da área, em 1440 e 390, nos quatro temas.
- NFR-2: INP ≤ 200 ms nas interações da área (abrir menu, folha, filtro, modal), medido no E2E com o perfil de desempenho do Chrome.
- NFR-3: os E2E existentes da área continuam verdes (atualizados para o novo DOM, sem afrouxar asserções) e a cobertura não cai do piso de 80%.
- NFR-4: 2.000 mídias rolam sem travar (INP ≤ 200 ms) com a tabela virtualizada.

## Acceptance criteria
- AC-1 (FR-1): Given o acervo Alquimia Prática, When a Biblioteca abre em 1440 e 390, Then bate com `media-library` e o par celular (captura), com a mídia tocando em verde.
- AC-2 (FR-2): Given uma mídia com "Falhou" e outra "Aguardando o transcritor", When a Biblioteca abre, Then as duas aparecem em atenção com as ações "Ver detalhes" e "Transcrever com Groq" (quando houver).
- AC-3 (FR-3): Given Ver como = grade, When a pessoa recarrega em outro navegador, Then continua em grade.
- AC-4 (FR-4): Given 3 mídias selecionadas no celular, When a barra de seleção aparece, Then ela fica no lugar da navegação inferior e a ação de lote vale para as 3.
- AC-5 (BR-4, negativo): Given um membro sem permissão de editar, When abre o ⋯, Then não vê Editar nem Remover.
- AC-6 (estados): Given busca sem resultado, acervo vazio, filtro de autoria, envio e edição, When renderizam, Then batem com os frames e as ações funcionam.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-6 | E2E + captura | Mídias de fixture |
| AC-2 | E2E | Estados semeados |
| AC-3 | integração (preferências) + E2E | Dois contextos |
| AC-4 | E2E | 390 px |
| AC-5 | E2E | Conta de membro |
| NFR-4 | E2E com medição | 2.000 mídias semeadas |

## References
Figma: [v2 · Mídia — Biblioteca e lista](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=368-2) · Plano: `docs/design/redesign-v2.md` · Telas v1: T14, T16 · KBC-034, KBC-051, KBC-105

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
