# v2: notas de implementação (KBC-124 e KBC-125)

Estas notas servem a quem migra uma área para a v2 depois da fundação (KBC-124) e da casca (KBC-125). O plano e as decisões estão em [`redesign-v2.md`](redesign-v2.md). Os desenhos de cada estado estão em `figma-recreation/redesign/src/features/<área>*.js` e na página `v2 · …` do Figma.

## Regras que valem para todas as áreas

- **Só tokens, nunca cores soltas.** Cores, raios, tipos e medidas da casca vêm de `apps/web/src/styles/tokens.css` (e de `colors.generated.css`). Os quatro temas (Escuro revisado, padrão pela D2; Claro; Escuro; Esotérico) mudam só os tokens. Uma área que usa os tokens funciona nos quatro sem mexer em nada.
- **Componentes de `@ui/index.js`.** Importe da biblioteca base, não refaça. A aparência fica em `styles/ui.css`, nas classes `ui-*`. Veja tudo junto em `/catalogo-ui`, que só existe em desenvolvimento.
- **Textos em pt-BR por `$localize`/`i18n`**, com id `@@area.chave`.
- **Nada some.** Toda ação e toda informação da v1 continua (BR-1). Mudam só a forma e a hierarquia.
- **Regra de áudio.** O que é de áudio só aparece com `AudioPresence.shown()` (veja abaixo).
- **Camada de cima (D5).** Todo menu, popover, dica ou lista de seleção usa `UiMenu` ou `UiOverlay`/`anchorOverlay`. Nada com `position: absolute` dentro de um contêiner que possa cortar.
- **Larguras.** Desktop a partir de 1024 px (desenhado em 1440), celular abaixo disso (desenhado em 390). Valide sempre as duas, em captura do Playwright.

## Tokens principais (`styles/tokens.css`)

| Grupo | Tokens |
|---|---|
| Tipo | `--font-ui` (Figtree, servida de `/fonts`), `--text-xs` 12, `--text-meta` 13, `--text-sm` 14, `--text-item` 15, `--text-md` 16, `--text-section` 22, `--text-hero` (64–72), `--weight-hero`, `--tracking-hero` |
| Espaço | `--space-1` … `--space-8` (4 a 32) |
| Raios | `--radius-pill` (botões, chips), `--radius-menu` 6, `--radius-card` 8, `--radius-cover` 4, `--radius-sheet` 16 |
| Toque | `--target` 44 (celular), `--target-desktop` 32 |
| Sobreposições | `--overlay-2/3/4` (hover, ativo, linha), `--overlay-line`, `--scrim`, `--shadow` |
| Cores | `--color-bg`, `--color-shell`, `--color-surface`, `--color-elevated`, `--color-text`, `--color-text-muted`, `--color-accent` (#2bd46b), `--color-accent-text`, `--color-on-accent`, `--color-danger`, `--color-focus` |
| Casca | `--shell-gap` 8, `--shell-topbar` 56, `--shell-sidebar` 300, `--shell-sidebar-collapsed` 72, `--shell-right` 340, `--shell-source` 460, `--shell-player` 72, `--shell-mobile-nav`, `--shell-mini-player`, `--shell-mobile-foot` (o espaço que uma página de celular deixa no pé) |
| Avisos flutuantes | `--float-top`: a borda de baixo do cabeçalho do painel principal, medida pela casca. Use `var(--float-top, var(--topbar-height))` |

## Componentes (`@ui/index.js`)

| Componente | Uso |
|---|---|
| `[uiButton]` | `uiButton="primary\|white\|outline\|ghost\|danger\|dark"`, `size="sm\|md\|lg"`, `block` |
| `[uiIconButton]` | `uiIconButton="plain\|play\|circle\|surface"`, `[size]` (32 no desktop, 44 no celular). Sempre com `aria-label` |
| `[uiChip]` | Chip em pílula. `[selected]` vira `aria-pressed` |
| `ui-icon`, `ICONS` | `name` e `size`. Ícones de traço, decorativos (o nome fica no botão) |
| `ui-cover` | Capa quadrada: `title` (iniciais e degradê de `coverGradient`) ou `icon`, mais `from`/`to` e `size` |
| `ui-library-item` | Linha da Sua biblioteca: capa projetada, título, meta e `pinned`. A casca põe a linha num `button.ui-libitem-row` ou num `a.ui-libitem-row` |
| `ui-card` | Cartão com capa, título, subtítulo e `progress` |
| `ui-menu` + `[uiMenuItem]` | Menu com gatilho próprio (`[uiMenuTrigger]` projetado), `label`, `menuId`, `align`, `direction`. Fica na camada de cima e vira folha abaixo de 1024 px |
| `[uiOverlay]`, `anchorOverlay`, `placeOverlay` | A camada de cima de qualquer popover ou lista (D5), detalhada abaixo |
| `ui-dialog` | Modal escuro: título 22, fechar no canto, ações à direita. Num celular vira folha alta. O fundo só fecha com o clique começado e terminado nele; `[closeOnBackdrop]="false"` onde fechar perde trabalho (o convite configurado) |
| `uiTablist` | Teclado de uma `role="tablist"` (APG): ← → trocam de aba e levam o foco, Home e End vão às pontas |
| `ui-sheet` | Folha do celular sobre um `<dialog>` modal (`full` ocupa a tela) |
| `ui-field`, `.ui-input`, `.ui-search` | Campo com rótulo, dica e erro (`fieldDescribedBy`) |
| `.ui-switch`, `.ui-check`, `.ui-radio` | Seleção sobre os `input` nativos |
| `ui-banner` | Aviso por tom (`info`, `ok`, `warn`, `err`) |
| `ui-pill` | Situação com palavra, nunca só cor |
| `ui-empty-state` | Estado vazio com ícone, título e texto |
| `ui-progress`, `ui-avatar`, `ui-logo`, `ui-code-input` | Barra fina, avatar, logo e os 6 dígitos |
| `ui-setting-row`, `ui-choice-card` | Linha de configuração (rótulo e descrição à esquerda, controle à direita) e cartão de escolha |
| `.ui-page-header`, `.ui-action-bar`, `.ui-section-title`, `.ui-row` | Os padrões do painel principal: cabeçalho com capa, barra de ações, título de seção e linha de tabela |

### Camada de cima (D5)

- **Menu de ações ou escolhas:** use `ui-menu`. Ele já resolve o foco, as setas, Escape, o clique fora e a folha no celular.
- **Popover ou lista que só existe aberta (`@if`):** ponha `[uiOverlay]="gatilho"` no elemento. Há opções para alinhar (`overlayAlign="start|end"`), escolher o lado (`overlaySide="below|above"`), igualar a largura ao gatilho (`overlayMatchWidth`) e virar folha abaixo de uma largura (`overlaySheetBelow`).
- **Lista sempre no DOM e mostrada por `[hidden]`:** chame `anchorOverlay(lista, gatilho, opções)` ao abrir e guarde a função que ela devolve, que tira a lista de novo. `subject-picker.ts` é o exemplo.
- **Menu de escolhas com rádio (mídia):** `app-menu-button` (`features/media/menu-button.ts`) também sobe para a camada de cima por `[uiOverlay]` e vira folha abaixo de 1024 px. Aceita `icon`, `group` (um título por grupo, como "Ordenar por" e "Ver como" da Biblioteca) e `divider` em cada opção.
- **O CSS do painel desenha só a aparência** (fundo, borda, raio, sombra, `max-height`). Nada de `position`, `top`/`left` nem `z-index`: a posição vem de `placeOverlay`, que vira de lado e desloca o painel para dentro da tela, com margem de 8.

## Casca (`features/chat/chat-page.html` e `features/shell/`)

Toda rota com sessão roda dentro de `ChatPage`. Rotas novas entram como filhas do `''` em `app.routes.ts` e aparecem no `<router-outlet>` do painel principal.

| Slot | O que é | Como uma área usa |
|---|---|---|
| Barra superior | `TopBar` (`app-top-bar`): ‹ ›, Início, busca global (⌘K / Ctrl K), atalho da Pesquisa com IA, o espaço das notificações, Pessoas e o menu do avatar | Não mexa nela. A busca global leva à busca do acervo em uso. O sino (KBC-133) entra no espaço `[topBarNotifications]` |
| Sua biblioteca | `Sidebar` (`app-sidebar`): "+ Criar", os chips, a busca e "Recentes", e as seções da D5. No celular é a folha "Menu" | Um item novo da biblioteca entra como linha de uma das seções, nunca como seção nova sem decisão |
| Painel principal | `main.conversation`, com o degradê `--tint` da capa do acervo | Use `.ui-page-header` e `.ui-action-bar` no topo da página |
| Painel direito | `RightPanel` (root): `open({ component, inputs, width: 'narrow' \| 'source', label })` e `close()` | 340 para "Tocando agora" ou a Fila, 460 para uma fonte. No celular ele cobre o painel principal |
| Barra do player / mini player | `app-mini-player` em `.shell-foot`. Mantém o elemento de mídia entre rotas | Só aparece com `AudioPresence.shown()`. Não crie outro `<audio>` |
| Navegação do celular | `BottomNav` com `navTabs()`: Conversas · Buscar · Biblioteca · Fila, ou Conversas · Buscar · Acervos sem áudio | Uma página de celular deixa `--shell-mobile-foot` livre no pé |
| Faixa "Vendo como" | `ActingBanner`, no topo de todas as telas. A `SessionShell` põe a faixa e a casca numa coluna da altura da tela | Não cubra. Não use `100dvh` numa página: a casca já tira a faixa da altura |
| Aviso de nova versão | `UpdateBanner` (KBC-123), fixo sob `--float-top` | Não cubra |

Serviços da casca:

- `AudioPresence`, fornecido pela `ChatPage`: `listens()`, `playing()`, `collectionHasAudio()` e `shown()`, que é a regra de áudio.
- `LibraryRecents`: o último uso de cada acervo e os documentos abertos. É a ordem "Recentes" e fica só neste navegador.
- `SignOut`: sair.

## Sua biblioteca (D5)

- **Seções**, nesta ordem: Fixados (`section:pinned`), Acervos (`section:collections`), Conversas (`section:conversations`) e Documentos (`section:documents`, só com o chip). Cada uma tem um `h2` com botão, contagem e seta, e `aria-expanded`/`aria-controls`. Os ramos recolhidos ficam como `branch:<slug>` em `localStorage` (`kb-chat.library-folded`), uma conveniência do navegador lida e gravada com `try/catch`.
- **Acervos:** árvore de um nível (`collectionTree`). O botão do acervo é `li.collection > .row > button.ui-libitem-row[data-slug]`, e o ativo leva `aria-current="true"`.
- **Conversas:** `nav[aria-label="Conversas"]`, agrupadas por `groupByRecency` (Hoje, Últimos 7 dias, Mais antigas). Cada linha é um `button.conversation` com o ícone do tipo, o título, e em seguida o tipo, o acervo, as perguntas e a situação.
- **Seletores de E2E:** `e2e/specs/shell-helpers.ts` (`library`, `collectionItem`, `chooseCollection`, `startNewConversation`, `startNewCollection`, `openSettings`, `openPeople`, `signOut`).

## Como validar uma área migrada

- Typecheck: `cd apps/web && npx tsc -p tsconfig.app.json --noEmit`.
- Specs da área: `npx ng test --include <spec> --watch=false --coverage=false`.
- Playwright em 1440 e 390 com capturas (`KBC_SHOTS=<pasta>`), comparadas com o frame da página `v2 · …`.
- Abra cada menu e confira nas capturas que nada sai cortado: `expectWholeOnTop` em `e2e/specs/v2-shell.spec.ts` é o modelo.
- Axe sem violação séria ou crítica, nos quatro temas.

## Conversa e Pesquisa com IA (KBC-126, KBC-127)

- **Início:** `features/chat/home/conversation-home.ts` entra no lugar da antiga `.welcome` de `chat-page.html`. Os atalhos recentes vêm de `homeTiles` (histórico do servidor na ordem do último uso, depois os acervos). Os chips de escopo usam `ChatStore.setKinds` e `ViewStore.select`.
- **Resultados:** `result-message` é uma página de busca; o container `results` (46rem) decide entre "Melhor resultado" ao lado da tabela ou uma lista só. Na busca, `.thread.search-page` (`searchPage` em `chat-page.ts`) solta o limite de `--column` e ocupa o painel principal, então o desktop mostra as duas colunas.
- **Filtros:** popovers com `[uiOverlay]`; no celular a folha mostra "Ver N resultados" quando as contagens na tela dizem o número (`draftResultCount`), senão "Ver resultados".
- **Fonte aberta:** `ChatStore.openSource`/`switchSource`/`leaveSources` levam a lista de fontes da resposta ao `app-document-panel`, que mostra "Fonte n de m", "Abrir documento", "Copiar trecho", "Próximo trecho" e "Tela cheia". No celular, `research-thread` abre a folha de leitura de 85% com abas por fonte; arrastar para baixo ou Esc devolve o foco à citação.
- **Seletores de E2E:** `e2e/specs/v2-conversa.spec.ts` e `e2e/specs/v2-pesquisa.spec.ts` (capturas com `KBC_SHOTS`).

## Configurações (KBC-131, KBC-132)

- **Página, não modal:** `/configuracoes` e `/configuracoes/<seção>` (`settings-routes.ts`, uma rota só). `SettingsStore.openSettings(seção)` navega até lá; a `SettingsHost` ficou só com o Assistente. As entradas são as da casca: o menu do avatar e o botão de pessoas na barra do topo (desktop), o Menu no celular; `settings-helpers.ts` usa as de `shell-helpers.ts`.
- **Seções:** `settings-index.ts` (id, endereço, grupo, quem vê). No desktop todas ficam na página, uma após a outra; rolar marca o índice e troca o endereço com `replaceUrl`. No celular a raiz lista as seções e cada uma é uma tela empurrada.
- **Seletores de E2E:** `e2e/specs/settings-helpers.ts` (`openSettings(page, seção)`, `openSection`, `openPeople`, `closeSettings`, `settingsSection`, `showTab`, `SETTINGS_AXE`). A página é a região "Configurações"; cada seção é uma região com o próprio título.
- **Modais:** o editor de pessoa, o convite configurado, o perfil de voz, recusar pedido e revogar transcritor usam `ui-dialog`. Um rodapé dentro de `ui-dialog` vai num elemento com `uiDialogFooter` fora de `@if`.
