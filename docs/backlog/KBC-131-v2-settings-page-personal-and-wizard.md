---
id: KBC-131
title: "Redesign v2: Configurações como página (índice fixo, linhas) — Conta, Sua IA, Preferências, Acessos, Sobre e o Assistente"
status: ready
slice: ui-v2-areas
outcome: qualquer pessoa ajusta a própria IA e as preferências numa página clara, e o assistente de início se parece com um começo
depends_on: [KBC-125]
---

# KBC-131 — Configurações v2 (pessoais) e Assistente

## Story
Como quem usa o app, quero as configurações numa página com índice (e não num modal apertado), com cada opção explicada ao lado do controle, para trocar a IA e as preferências sem me perder.

## Scope
**In:** Configurações sai do modal e vira rota própria dentro da casca: título 48, busca no canto, índice fixo agrupado (Você · Administração · Mídia · Sobre, só os grupos que a pessoa vê), faixa fixa "Configurações › Seção" ao rolar; seções Conta (com Sair), Sua IA (quem atende agora, provedores em lista com o escolhido aberto: passos, Quanto custa · Privacidade · Limites, campos, chave recusada), Preferências (cartões de escolha, toggle, selects), Acessos à sua conta (tabela e vazio), Sobre; Salvar fixo no rodapé onde a v1 tem Salvar; celular com o índice raiz e cada seção em tela empurrada; Assistente em tela cheia (PASSO n DE 4, barra de progresso, cartões grandes, Pular · Voltar · Continuar, variante de membro).
**Out:** seções de administração e mídia (KBC-132).

## Business rules
- BR-1: a área mantém toda a informação e todas as ações da v1; mudam a forma, a hierarquia e o padrão de interação (docs/design/redesign-v2.md). Nenhuma ação sai sem decisão do dono.
- BR-2: regra de áudio: player, mini player, Biblioteca de mídia, Fila de processamento, Meus marcadores, o chip "Áudios" e os cartões de ouvir só aparecem quando o acervo em uso tem áudio ou algo está tocando.
- BR-3: cada estado existe em desktop (≥ 1024 px, desenhado em 1440) e celular (< 1024 px, desenhado em 390), conforme o par de frames `id` / `id@mobile` da página v2.
- BR-4: o índice mostra só as seções que a pessoa pode ver (membro: Conta, Sua IA quando tem "Configurações de IA próprias", Preferências, Acessos, Sobre), como na v1.
- BR-5: abrir Configurações pelo menu do avatar leva à rota `/configuracoes` (e `/configuracoes/<seção>`), que funciona ao recarregar e no voltar do navegador.

## Functional requirements
- FR-1: a rota de Configurações deve mostrar o índice e rolar até a seção da URL; rolar a página deve atualizar o item ativo do índice e a URL sem recarregar. (BR-4, BR-5)
- FR-2: em Sua IA, escolher um provedor deve abrir o guia dele embaixo (passos, custos, campos); provedores indisponíveis aparecem esmaecidos com o motivo e não podem ser escolhidos. (BR-1)
- FR-3: no celular, a raiz deve listar o perfil e os grupos com "›"; cada seção abre como tela empurrada com "‹". (BR-3)
- FR-4: o Assistente deve manter os 4 passos e as escolhas da v1, com Pular em todos e Voltar a partir do 2. (BR-1)

## Non-functional requirements
- NFR-1: nenhuma violação séria ou crítica do axe nos estados da área, em 1440 e 390, nos quatro temas.
- NFR-2: INP ≤ 200 ms nas interações da área (abrir menu, folha, filtro, modal), medido no E2E com o perfil de desempenho do Chrome.
- NFR-3: os E2E existentes da área continuam verdes (atualizados para o novo DOM, sem afrouxar asserções) e a cobertura não cai do piso de 80%.

## Acceptance criteria
- AC-1 (FR-1, BR-5): Given a pessoa em `/configuracoes/preferencias`, When recarrega, Then a página abre em Preferências com o item ativo no índice; When rola até Acessos, Then o índice e a URL mudam para Acessos.
- AC-2 (FR-2): Given Sua IA, When a pessoa escolhe OpenRouter, Then o guia abre com os 5 passos, os 3 cartões e "Conectar OpenRouter"; When escolhe OpenAI e a chave é recusada, Then o campo mostra "A chave não foi aceita pelo provedor.".
- AC-3 (FR-2, negativo): Given a assinatura do Claude não instalada, When a pessoa tenta escolher, Then a opção está desabilitada com "Não instalado…" e o nome acessível explica o motivo.
- AC-4 (BR-4): Given um membro com a IA da aplicação, When abre Configurações, Then o índice mostra Conta, Sua IA, Preferências, Acessos e Sobre, e o cartão "Quem atende você agora" mostra "Pesquisas restantes hoje: 5 de 5".
- AC-5 (FR-3): Given 390 px, When a pessoa toca "Sua IA" na raiz, Then a tela Sua IA abre com "‹ Sua IA"; o "‹" volta à raiz.
- AC-6 (FR-4): Given o Assistente no passo 3, When a pessoa toca Voltar, Then volta ao passo 2 com a escolha anterior marcada; Pular fecha e o app abre na home.
- AC-7 (estados): Given Acessos vazio, Preferências de membro e Sobre, When renderizam, Then batem com os frames (captura).

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | E2E | Rotas e rolagem |
| AC-2, AC-3 | componente + E2E | Provedor stub, chave recusada |
| AC-4 | E2E | Conta de membro |
| AC-5 | E2E | 390 px |
| AC-6 | E2E | Primeiro acesso |
| AC-7 | E2E + captura | |

## References
Figma: [v2 · Configurações](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=380-2) (`settings-ai*`, `settings-preferences*`, `settings-accesses*`, `settings-about`, `settings-wizard-*`, `settings-ai@mobile-index`) · Plano: `docs/design/redesign-v2.md` · Telas v1: T6, T7 · KBC-007, KBC-023

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
