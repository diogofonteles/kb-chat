---
id: KBC-125
title: "Redesign v2: casca do app — barra superior, Sua biblioteca, barra do player e navegação do celular com mini player"
status: ready
slice: ui-v2-skeleton
outcome: toda tela com sessão ganha a navegação de app de streaming (busca e IA no centro, biblioteca lateral, player sempre à mão quando há áudio)
depends_on: [KBC-124]
---

# KBC-125 — Casca v2

## Story
Como quem estuda, quero a busca e a IA sempre no topo, meus acervos e conversas numa biblioteca lateral e o player sempre à mão quando há áudio, para ir de qualquer lugar a qualquer lugar sem perder o que está tocando.

## Scope
**In:** barra superior (‹ ›, Início, busca global que leva à busca atual, atalho ⌘K/Ctrl K que foca a busca, atalho da Pesquisa com IA, Pessoas com o contador de pedidos, avatar com o menu Configurações · Pessoas e permissões · Ver como · Como usar · Sair); Sua biblioteca (+ Criar com o que já existe hoje — Nova conversa, Novo acervo —, chips Acervos/Áudios/Conversas/Documentos, busca e "Recentes", itens fixados Biblioteca/Meus marcadores/Fila de processamento, acervos, conversas, gasto com IA do dia, expandir); barra do player persistente; celular: navegação inferior (Conversas · Buscar · Biblioteca · Fila, ou Conversas · Buscar · Acervos sem áudio), mini player, folha "Sua biblioteca"; regra de áudio; a faixa azul "Vendo como".
**Out:** sino de notificações (KBC-133, aqui o ícone não aparece); sugestões da busca global (KBC-134); painel direito "Tocando agora"/Fila (KBC-129); conteúdo de cada área (o conteúdo atual roda dentro da casca nova).

## Business rules
- BR-1: a área mantém toda a informação e todas as ações da v1; mudam a forma, a hierarquia e o padrão de interação (docs/design/redesign-v2.md). Nenhuma ação sai sem decisão do dono.
- BR-2: regra de áudio: player, mini player, Biblioteca de mídia, Fila de processamento, Meus marcadores, o chip "Áudios" e os cartões de ouvir só aparecem quando o acervo em uso tem áudio ou algo está tocando.
- BR-3: cada estado existe em desktop (≥ 1024 px, desenhado em 1440) e celular (< 1024 px, desenhado em 390), conforme o par de frames `id` / `id@mobile` da página v2.
- BR-4: o seletor de acervo da v1 vira a lista de acervos da Sua biblioteca; o acervo em uso é o item ativo. O tema sai da lateral e fica em Configurações › Preferências.
- BR-5: Pessoas, Ver como e o contador de pedidos só aparecem para quem tem a permissão (como na v1).

## Functional requirements
- FR-1: a casca deve envolver todas as rotas com sessão, com a lateral de 300 (recolhível) e o painel principal; o painel direito é um slot opcional. (BR-1)
- FR-2: ⌘K / Ctrl K deve focar a busca global em qualquer tela (menos com um campo de texto em foco) e Enter deve abrir os resultados do acervo em uso. (BR-1)
- FR-3: a barra do player deve aparecer quando algo está tocando ou quando o acervo em uso tem áudio, e manter a reprodução ao navegar entre rotas sem recriar o elemento de mídia. (BR-2)
- FR-4: no celular, a navegação inferior e o mini player devem ficar sobre uma faixa opaca, sem o conteúdo aparecer por trás dos rótulos. (BR-2, BR-3)
- FR-5: "Recentes" deve ordenar os itens da Sua biblioteca pelo último uso; os chips filtram por tipo. (BR-4)

## Non-functional requirements
- NFR-1: nenhuma violação séria ou crítica do axe nos estados da área, em 1440 e 390, nos quatro temas.
- NFR-2: INP ≤ 200 ms nas interações da área (abrir menu, folha, filtro, modal), medido no E2E com o perfil de desempenho do Chrome.
- NFR-3: os E2E existentes da área continuam verdes (atualizados para o novo DOM, sem afrouxar asserções) e a cobertura não cai do piso de 80%.

## Acceptance criteria
- AC-1 (FR-1): Given uma pessoa com sessão em 1440, When abre qualquer rota, Then vê a barra superior, a Sua biblioteca e o painel principal como em `chat-empty` (captura).
- AC-2 (FR-2): Given a tela de Biblioteca, When a pessoa aperta ⌘K, digita "ritmo" e Enter, Then vê os resultados do acervo em uso; Given o foco num campo de texto, When aperta ⌘K, Then nada muda no campo.
- AC-3 (FR-3, BR-2): Given um áudio tocando, When a pessoa vai da Biblioteca para a Conversa, Then o som não para e a barra do player continua.
- AC-4 (BR-2): Given o acervo Hermetismo (só textos) e nada tocando, When a casca abre, Then não há barra do player, itens fixados de mídia nem o chip "Áudios"; no celular a navegação é Conversas · Buscar · Acervos.
- AC-5 (FR-4): Given 390 px com uma lista longa, When rola até o fim, Then o último item fica visível acima do mini player e da navegação.
- AC-6 (BR-5): Given um membro sem permissões de master, When abre o menu do avatar, Then não vê Pessoas e permissões nem Ver como.
- AC-7 (BR-4): Given a lista de acervos, When a pessoa escolhe Cabala, Then Cabala vira o acervo em uso (como o seletor da v1) e fica ativo na lista.
- AC-8 (acting): Given um master vendo como Ana Lima, When navega, Then a faixa azul "Vendo como Ana Lima · Sair" fica no topo em todas as telas.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-4, AC-5, AC-8 | E2E + captura | 1440 e 390; acervo só de textos e com áudio |
| AC-2 | E2E | Atalho com e sem foco em campo |
| AC-3 | E2E | Conta elementos de mídia |
| AC-6 | E2E | Conta de membro |
| AC-7 | E2E | Troca de acervo |

## References
Figma: [v2 · Telas-chave](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=367-2), [v2 · Conversa](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=376-2) (`chat-empty`, `chat-sidebar-drawer-mobile`, `chat-acting`) · Plano: `docs/design/redesign-v2.md` · Telas v1: T5 · ADR 0025 (player)

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
