---
id: KBC-126
title: "Redesign v2: início da Conversa e busca de documentos — home de streaming, Melhor resultado e filtros em chips"
status: ready
slice: ui-v2-areas
outcome: quem abre o app encontra por onde começar (recentes, assuntos) e acha o documento certo mais rápido; meta do brief, ≥ 50% das buscas abrem um documento
depends_on: [KBC-125]
---

# KBC-126 — Conversa e busca v2

## Story
Como quem estuda, quero começar pelo que usei por último ou por um assunto, e ver o melhor resultado em destaque com os filtros à mão, para chegar ao texto certo com menos cliques.

## Scope
**In:** os estados de v2 · Conversa da home e dos resultados: chips de escopo (Tudo · Documentos · Pesquisa com IA) e "Em: <acervo>"; saudação; atalhos recentes 2×3 (acervos, buscas e pesquisas do histórico); "Comece por um assunto" com cartões de capa; caixa de pergunta fixa com os modos em chips; resultados como página de busca ("Resultados para …", modo, tempo), autoria segmentada com contagens, chips de faceta com popover de seleção, chips ativos com ✕ e "Limpar filtros", **Melhor resultado** e a tabela "Documentos", cópias, ocultos fora do tema, Mostrar mais; vazio, nada encontrado, com filtros, erro, sem acervo; filtros em folha no celular; erros de acervo.
**Out:** documento e Pesquisa com IA (KBC-127); sugestões enquanto digita e buscas recentes na barra superior (KBC-134).

## Business rules
- BR-1: a área mantém toda a informação e todas as ações da v1; mudam a forma, a hierarquia e o padrão de interação (docs/design/redesign-v2.md). Nenhuma ação sai sem decisão do dono.
- BR-2: regra de áudio: player, mini player, Biblioteca de mídia, Fila de processamento, Meus marcadores, o chip "Áudios" e os cartões de ouvir só aparecem quando o acervo em uso tem áudio ou algo está tocando.
- BR-3: cada estado existe em desktop (≥ 1024 px, desenhado em 1440) e celular (< 1024 px, desenhado em 390), conforme o par de frames `id` / `id@mobile` da página v2.
- BR-4: o Melhor resultado é o primeiro da ordem atual da busca (não muda o ranking); a tabela lista os demais.
- BR-5: os atalhos recentes vêm do histórico do servidor (KBC-029) e respeitam o nível e o acesso de hoje (KBC-110).

## Functional requirements
- FR-1: a home deve mostrar até 6 atalhos recentes, cada um abrindo o acervo, a busca ou a conversa. (BR-5)
- FR-2: a página de resultados deve mostrar o Melhor resultado em cartão e os demais na tabela, com as mesmas facetas, contagens, cópias e "Fora do tema" da v1. (BR-1, BR-4)
- FR-3: o popover de assuntos deve listar os valores com contagem e caixas de seleção, aplicar ao marcar e fechar com Esc; no celular, os filtros abrem numa folha com "Ver N resultados". (BR-3)
- FR-4: a caixa de pergunta deve ficar fixa no rodapé do painel, com os modos em chips e a ajuda do modo escolhido.

## Non-functional requirements
- NFR-1: nenhuma violação séria ou crítica do axe nos estados da área, em 1440 e 390, nos quatro temas.
- NFR-2: INP ≤ 200 ms nas interações da área (abrir menu, folha, filtro, modal), medido no E2E com o perfil de desempenho do Chrome.
- NFR-3: os E2E existentes da área continuam verdes (atualizados para o novo DOM, sem afrouxar asserções) e a cobertura não cai do piso de 80%.

## Acceptance criteria
- AC-1 (FR-1, BR-5): Given um histórico com 3 conversas e 2 buscas, When a home abre, Then os atalhos mostram esses itens na ordem do último uso, e tocar num abre o item.
- AC-2 (BR-5, negativo): Given uma conversa cujas fontes saíram do nível da pessoa, When a home abre, Then o atalho aparece sem revelar título restrito (mesma máscara do KBC-110).
- AC-3 (FR-2, BR-4): Given a busca "lei do ritmo", When os resultados chegam, Then o primeiro aparece como Melhor resultado e os outros na tabela, com as mesmas contagens da v1 para a mesma busca.
- AC-4 (FR-3): Given os resultados, When a pessoa marca "Cabala" no popover de assuntos, Then a lista filtra, o chip "Cabala ✕" aparece, e Esc fecha o popover devolvendo o foco ao chip.
- AC-5 (FR-3): Given 390 px, When a pessoa abre Filtros, marca um tipo e toca "Ver 2 resultados", Then a folha fecha e a lista mostra 2.
- AC-6 (estados): Given cada estado de resultados (nada encontrado, com filtros, erro, sem acervo, mostrar mais, fora do tema), When renderiza, Then bate com o frame correspondente (captura) e a ação de cada estado funciona.
- AC-7 (BR-1): Given a v1 e a v2, When se compara a lista de ações da home e dos resultados, Then nenhuma falta.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-2 | integração (histórico) + E2E | Conta com nível baixo para AC-2 |
| AC-3 | E2E | Vault de fixture, compara contagens |
| AC-4, AC-5 | componente + E2E | Teclado e folha |
| AC-6, AC-7 | E2E + captura | 1440 e 390 |

## References
Figma: [v2 · Conversa](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=376-2) (`chat-empty*`, `chat-results*`, `chat-filters-sheet-mobile`) · Plano: `docs/design/redesign-v2.md` · Telas v1: T1, T2 · KBC-002, KBC-006, KBC-020, KBC-029

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
