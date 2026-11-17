# Redesign v2 — plano da atualização completa da UI/UX

Pedido do dono (2026-11-15): levar o app inteiro para o redesign v2 e criar itens para as funcionalidades que a v2 idealizou e o app ainda não tem. Itens no backlog: KBC-124 a KBC-137 (`docs/backlog/README.md`, seção "Prioridade: redesign v2").

## Fonte do desenho

Arquivo Figma "Nova Alexandria — UI": https://www.figma.com/design/au1MI6z2Vwy9tnqOv2vrfH. As páginas `v2 ·` são a referência de cada item. Cada frame tem o `id` do estado de `plan/screens.json` e o par `id@mobile`.

| Página v2 (node) | Frames | Item |
|---|---|---|
| v2 · Componentes (`386-2`) | 19 conjuntos, 61 variantes | KBC-124 |
| v2 · Auth (`382-2`), v2 · Públicas (`383-2`) | 38 + 4 | KBC-124 |
| v2 · Telas-chave (`367-2`): Player, Pesquisa com IA (com a fonte aberta), Documento | 7 | KBC-125, KBC-127, KBC-129 |
| v2 · Conversa (`376-2`) | 70 | KBC-126, KBC-127 |
| v2 · Mídia — Biblioteca e lista (`368-2`) | 54 | KBC-128 |
| v2 · Mídia — Player (`371-2`), v2 · Mídia — Fila e Marcadores (`370-2`) | 38 + 8 | KBC-129 |
| v2 · Mídia — Preparar, Faixas e Limites (`373-2`) | 28 | KBC-130 |
| v2 · Configurações (`380-2`) | 91 | KBC-131, KBC-132 |
| v2 · Fluxos (`386-651`) | 7 protótipos | aceite de ponta a ponta de cada item |

As notas de UX de cada lote (os problemas da v1 por estado, o padrão adotado e as decisões) ficam em `figma-recreation/redesign/notes/`, fora do git. O que vale para o app está resumido abaixo e nos itens.

## Conceito

Um app de streaming de conhecimento. O que se ouve ou se lê é um item com capa e vive em acervos. Os acervos aparecem numa biblioteca lateral, e o player está sempre presente quando há áudio. A busca e a IA ficam no centro da barra superior. A referência visual é o Spotify, mas sem marca, nome, logo, fotos nem textos dele. O verde próprio é #2bd46b e a fonte é Figtree.

### Casca (desktop 1440, celular 390)

- **Barra superior (56):**
  - Início;
  - busca global com ⌘K e o atalho da Pesquisa com IA;
  - à direita, notificações, Pessoas e o avatar (Configurações, Pessoas e permissões, Ver como, Como usar, Sair).
- **Sua biblioteca (300):**
  - "+ Criar" e os chips Acervos, Áudios, Conversas e Documentos;
  - "Recentes";
  - itens fixados com o alfinete verde (Biblioteca, Meus marcadores, Fila de processamento);
  - acervos e conversas;
  - no rodapé, o gasto com IA do dia.
- **Painel principal:** cabeçalho em degradê da cor da capa.
- **Painel direito (opcional):**
  - 340 para "Tocando agora" ou a Fila;
  - 460 para a fonte aberta na Pesquisa com IA.
- **Barra do player (72).**
- **Celular:**
  - navegação inferior com mini player;
  - menus viram folha;
  - modais viram folha alta (Cancelar · título · ação);
  - seleção vira barra inferior.

### Regra de áudio (vale para todos os itens)

O player, o mini player, a Biblioteca de mídia, a Fila de processamento, os Meus marcadores, o chip "Áudios" e os cartões de ouvir só aparecem quando o acervo em uso tem áudio ou quando algo está tocando. Num acervo só de textos, a navegação do celular é Conversas · Buscar · Acervos.

### Padrões

| v1 | v2 |
|---|---|
| Título pequeno e botões soltos | Cabeçalho com capa, sobretítulo, título de 64 a 72 em extra-negrito e meta. Barra de ações com play verde, ícones e, à direita, busca e ordenação |
| Listas de cartões com borda | Tabela: # · capa + título · colunas · situação · ⋯ |
| Aviso com borda lateral | Cartões "Precisa da sua atenção", com ação direta |
| `<select>` para filtrar | Chips em pílula; listas longas abrem um popover ou uma folha |
| Diálogos claros | Modal escuro centralizado: título 22, fechar no canto, ações à direita |
| Configurações em modal | Página com índice fixo e linhas (rótulo e descrição à esquerda, controle à direita) |
| Pesquisa com IA abre o documento em outro lugar | A fonte abre ao lado (460) já no trecho; no celular, numa folha de leitura de 85% |

### Tokens

- Cores: modo `revisado` da coleção Theme. Fundo #121212, superfícies #1f1f1f e #2a2a2a, texto #fff e #b3b3b3, verde #2bd46b, perigo #f3727f, aviso #ffb02e, info #6ea8ff.
- Raios: pílula (999) nos botões e chips; 6 a 8 nos cartões e menus; 16 no topo das folhas.
- Áreas de toque: no mínimo 32 no desktop e 44 no celular. Contraste conforme a WCAG 2.2 AA.

## Estratégia

1. **Fundação primeiro (KBC-124):**
   - o tema `revisado` entra no app como "Escuro (revisado)";
   - os componentes base viram a biblioteca de UI do web (`apps/web`), espelhando a página v2 · Componentes;
   - as telas sem sessão (Entrar e páginas públicas) são as primeiras a migrar, porque não dependem da casca.
2. **Casca (KBC-125):** troca a lateral e o topo de todas as telas de uma vez. Telas que ainda não migraram rodam dentro da casca nova, com o conteúdo antigo no tema novo.
3. **Áreas:** Conversa e busca (126), Documento e Pesquisa com IA (127), Biblioteca (128), Player, Fila e Marcadores (129), Preparar (130), Configurações (131 e 132). Cada área sai inteira, em desktop e celular, com todos os estados da página v2 correspondente.
4. **Funcionalidades novas:** KBC-133 a KBC-137, mais os itens que já existiam e a v2 desenhou (KBC-052, 053, 054, 055 e 059). Entram depois da casca, porque dependem dela: sino, busca global, painel direito, "+ Criar" e itens fixados.

## Barra de qualidade (soma-se à definição de pronto global)

- Todos os estados da página v2 da área estão implementados nas duas larguras. A validação local compara cada estado com o frame do Figma (captura em 1440 e 390) e registra as capturas.
- A informação e as ações da v1 continuam. Nenhuma ação é removida sem decisão do dono.
- Os textos de UI ficam em pt-BR via `$localize`. Os dados de teste vêm das fixtures.
- Nenhuma violação séria do axe em 1440 e 390, e os E2E existentes da área seguem verdes (atualizados para o novo DOM, sem afrouxar asserções).

## Decisões assumidas (o dono pode mudar)

- **D1:** a v2 substitui a v1 área por área, sem feature flag. Na transição, convivem telas novas e telas antigas, todas dentro da casca nova.
- **D2:** "Escuro (revisado)" vira o tema padrão de quem não escolheu um tema. Claro, Escuro e Esotérico continuam como opções e recebem os mesmos componentes.
- **D3:** os textos fora da captura listados em `figma-recreation/redesign/REPORT.md` entram como estão desenhados. O dono pode trocá-los na revisão de cada item.
- **D4:** a página `v2 ★ Telas-chave redesenhadas` não é referência. Vale a `v2 · Telas-chave`.
- **D5 (dono, 16/11/2026, a partir das capturas do trabalho em andamento; vale sobre o Figma onde conflitar):**
  1. **Menus nunca cortados.** Todo menu, popover, dica e lista de seleção sobe para a camada de cima (top layer, API de popover) ancorado no seu gatilho. Ele vira para cima quando não cabe embaixo e se desloca para dentro da tela em 1440 e em 390. Nenhum contêiner (a lateral, um painel com rolagem, a folha do celular) pode cortá-lo ou cobri-lo. No celular, o menu continua virando folha de baixo. Exemplo: o "+ Criar" (Nova conversa, Novo acervo) da Sua biblioteca, que antes saía cortado pela lateral.
  2. **Sua biblioteca em seções que não se misturam.** A lista tem seções separadas, cada uma com título, contagem e seta para recolher:
     - **Fixados:** Biblioteca, Meus marcadores e Fila de processamento, só quando o acervo tem áudio (regra de áudio).
     - **Acervos:** com as capas. Os sub-acervos aparecem como árvore visível, com recuo, linha-guia e seta no acervo pai.
     - **Conversas:** linhas compactas de texto, sem capa, com o ícone do tipo (✦ para a Pesquisa com IA, lupa para a Busca) e o acervo como texto secundário. Ficam agrupadas por recência: Hoje, Últimos 7 dias, Mais antigas.
     - **Documentos:** só com o chip Documentos ligado.

     Os chips (Acervos, Áudios, Conversas, Documentos) filtram para uma só seção. Uma conversa nunca se parece com um acervo. Enquanto a pessoa digita na busca da biblioteca, as seções e os ramos recolhidos se abrem para mostrar o que bate. O que ela recolheu fica guardado só neste navegador.

