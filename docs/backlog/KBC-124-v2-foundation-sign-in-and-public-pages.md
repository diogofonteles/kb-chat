---
id: KBC-124
title: "Redesign v2 (esqueleto): tema revisado, Figtree e componentes base, com Entrar e as páginas públicas já na v2"
status: ready
slice: ui-v2-skeleton
outcome: o app passa a ter a linguagem visual v2 e uma biblioteca de componentes que as próximas áreas reaproveitam; as telas sem sessão já saem na v2
depends_on: []
---

# KBC-124 — Fundação v2 com Entrar e páginas públicas

## Story
Como quem abre a Nova Alexandria, quero entrar numa tela com a cara nova do produto (fundo escuro, verde próprio, botões em pílula), para reconhecer o app e chegar ao acervo sem fricção; como quem mantém o app, quero os componentes base da v2 prontos para as próximas áreas.

## Scope
**In:** tema "Escuro (revisado)" (tokens do modo `revisado`, Figtree), padrão para quem não escolheu tema (D2); componentes base do web espelhando a página v2 · Componentes (botão nos 6 tipos, botão de ícone, chip, pill, campo, busca, toggle/caixa/rádio, banner, capa tipográfica, cartão, estado vazio, menu, modal, folha do celular); as 20 telas de Entrar (boot, login e seus estados, código por e-mail, pedir acesso, não convidado) e /privacidade e /tutorial na v2.
**Out:** casca com sessão (KBC-125); as demais áreas.

## Business rules
- BR-1: a área mantém toda a informação e todas as ações da v1; mudam a forma, a hierarquia e o padrão de interação (docs/design/redesign-v2.md). Nenhuma ação sai sem decisão do dono.
- BR-2: regra de áudio: player, mini player, Biblioteca de mídia, Fila de processamento, Meus marcadores, o chip "Áudios" e os cartões de ouvir só aparecem quando o acervo em uso tem áudio ou algo está tocando.
- BR-3: cada estado existe em desktop (≥ 1024 px, desenhado em 1440) e celular (< 1024 px, desenhado em 390), conforme o par de frames `id` / `id@mobile` da página v2.
- BR-4: os temas Claro, Escuro e Esotérico continuam escolhíveis e usam os mesmos componentes; só os tokens mudam.
- BR-5: o login com o Google usa o botão oficial do Google Identity Services, mantendo os estados da v1 (carregando, indisponível, não configurado, entrando, falha).

## Functional requirements
- FR-1: o web deve expor os tokens do modo revisado como variáveis CSS e carregar a Figtree localmente (sem CDN em produção, por causa da CSP). (BR-4)
- FR-2: quem não salvou tema deve abrir o app no "Escuro (revisado)"; quem salvou continua no seu. (D2)
- FR-3: os componentes base devem existir como componentes standalone com estados de foco, desabilitado e erro, e uma página de catálogo só em desenvolvimento. (BR-1)
- FR-4: as telas de Entrar devem seguir v2 · Auth: logo, "Nova Alexandria", frase de valor, cartão de 420 com a pilha de botões; erros em banner; o código em 6 caixas de dígito com colar, apagar e avanço automático. (BR-1, BR-5)
- FR-5: /privacidade e /tutorial devem seguir v2 · Públicas: índice lateral que marca a seção visível (chips no celular), coluna de 720, capturas em cartões com marcas A/B/C. (BR-3)

## Non-functional requirements
- NFR-1: nenhuma violação séria ou crítica do axe nos estados da área, em 1440 e 390, nos quatro temas.
- NFR-2: INP ≤ 200 ms nas interações da área (abrir menu, folha, filtro, modal), medido no E2E com o perfil de desempenho do Chrome.
- NFR-3: os E2E existentes da área continuam verdes (atualizados para o novo DOM, sem afrouxar asserções) e a cobertura não cai do piso de 80%.
- NFR-4: LCP da tela de Entrar ≤ 2,0 s em 4G simulado (Lighthouse mobile), com a fonte sem bloquear a renderização.

## Acceptance criteria
- AC-1 (FR-2, BR-4): Given uma conta sem tema salvo, When ela entra, Then o app abre no "Escuro (revisado)"; Given uma conta com "Claro" salvo, Then continua no Claro.
- AC-2 (FR-4): Given a tela de Entrar em 1440 e 390, When carrega, Then bate com `auth-login` e `auth-login@mobile` (captura registrada).
- AC-3 (FR-4, BR-5): Given o script do Google sem carregar, When a tela abre, Then aparece o banner "Não consegui carregar o botão do Google." com **Tentar de novo**, e Entrar com código continua disponível.
- AC-4 (FR-4): Given o passo do código, When a pessoa cola "481920", Then as 6 caixas se preenchem e **Entrar** fica ativo; When apaga com Backspace numa caixa vazia, Then o foco volta para a anterior.
- AC-5 (FR-4): Given o pedido de acesso com os campos vazios, When envia, Then cada campo mostra o seu erro embaixo e o foco vai ao primeiro com erro.
- AC-6 (FR-4): Given uma conta Google sem convite, When entra, Then vê a linha da conta (avatar, nome, e-mail), **Solicitar acesso** e **Sair**; os estados enviada, em análise e recusada mostram a pill e a frase da v1.
- AC-7 (FR-5): Given /privacidade no celular, When a pessoa toca no chip "Por quanto tempo", Then a página rola até a seção e o chip fica ativo.
- AC-8 (FR-3, NFR-1): Given a página de catálogo, When roda o axe em cada componente, Then não há violação séria; o foco é visível em todos.
- AC-9 (negativo, BR-1): Given a v1 e a v2 de Entrar, When se compara a lista de ações (Google, código, pedir acesso, Como usar, Privacidade, Sair), Then nenhuma falta.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | integração (preferências) + E2E | Duas contas de fixture |
| AC-2, AC-6, AC-7 | E2E + captura | 1440 e 390, comparadas aos frames do Figma |
| AC-3 | E2E | Script do Google bloqueado na rota |
| AC-4, AC-5 | componente + E2E | Colar, apagar, erros |
| AC-8 | E2E (axe) | Página de catálogo |
| AC-9 | E2E | Lista de ações por papel |

## References
Figma: [v2 · Auth](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=382-2), [v2 · Públicas](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=383-2), [v2 · Componentes](https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH/?node-id=386-2) · Plano: `docs/design/redesign-v2.md` · Telas v1: T8, T10, T11, T13 · ADR 0008, 0011

## Decisões assumidas (o dono pode mudar)
- D2 do plano (tema padrão). Textos novos: as pills "Enviada", "Em análise" e "Recusada".

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
