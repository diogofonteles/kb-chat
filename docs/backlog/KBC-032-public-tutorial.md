---
id: KBC-032
title: "Tutorial público com imagens: como usar cada funcionalidade, aberto sem login"
status: in-review
slice: release-1
outcome: quem recebe um convite (ou ainda nem tem acesso) entende sozinho, pelo celular ou pelo computador, como entrar, buscar, pesquisar com IA, configurar a própria IA e, se for administrador, convidar e ceder a IA da aplicação
depends_on: [KBC-016, KBC-029, KBC-030, KBC-031]
---

# KBC-032 — Tutorial público com imagens

## Story
Como pessoa que acabou de receber acesso à Nova Alexandria (ou que ainda está pensando em pedir), quero uma página de "Como usar" com passos curtos e imagens reais das telas, aberta sem login, para entender cada funcionalidade sem precisar perguntar ao administrador.

Pedido do dono em 2026-10-27: "Faça uma página de tutorial de como usar todas as features desse app. Esse tutorial deve incluir imagens para facilitar o entendimento, que seja bem intuitivo e fácil de entender. O link deve ser acessível inclusive sem login."

## Scope
**In:**
- Rota pública `/tutorial` (como `/privacidade`, KBC-016): abre com ou sem sessão; título da aba "Como usar — Nova Alexandria".
- Links: "Como usar" na tela de entrada (ao lado de "Privacidade"), ícone de ajuda "?" no cabeçalho do app (abre em nova aba, para não perder a conversa) e um link na política de privacidade.
- Sumário com âncoras estáveis (ex.: `/tutorial#pesquisa-com-ia`) e as seções: O que é; Entrar; Busca sem IA; Pesquisa com IA; Histórico; Sua IA; Preferências; Para administradores ("só para administradores"); Perguntas frequentes (com link para `/privacidade`).
- Imagens reais das telas, geradas por um script Playwright contra o servidor E2E (vault de fixture, IA falsa, pessoas fictícias com e-mail `.test`), com destaques numerados desenhados antes da captura; WebP com hash no nome; `pnpm tutorial:screenshots` regenera tudo e o manifesto.
- Caddy: `/tutorial` sem cache, com o mesmo CSP; imagens com cache longo (nome com hash). Smoke de produção confere `/tutorial`.
- Testes que falham se faltar uma âncora, uma imagem ou um texto alternativo; documentação de como regenerar.

**Out:**
- Vídeos ou GIFs animados; tradução para outros idiomas; busca dentro do tutorial.
- Tutorial interativo dentro do app (tour guiado).
- Capturas do acervo real ou de pessoas reais.

## Business rules
- BR-1: o tutorial é público; nada nele depende de sessão nem mostra dado de alguém (só o vault de fixture e pessoas fictícias).
- BR-2: todo passo mostrado numa imagem também está escrito no texto; a imagem ajuda, nunca é o único caminho (WCAG 1.1.1).
- BR-3: o texto descreve o que o app faz hoje, com os mesmos nomes da tela (vocabulário de `docs/design/screens.md`); a seção de administradores avisa que só masters veem aquelas telas.
- BR-4: imagens sem segredo, sem chave e sem o e-mail do dono; os números de custo e de cota são os do servidor de teste.

## Functional requirements
- FR-1: `/tutorial` renderiza a página com ou sem sessão; com sessão, "Voltar à Nova Alexandria" leva ao app. (BR-1)
- FR-2: um sumário lista as seções; cada item leva à âncora da seção; abrir `/tutorial#<âncora>` já mostra a seção, com o foco no título dela.
- FR-3: cada seção tem passos numerados em texto e uma ou mais figuras com legenda e texto alternativo. (BR-2)
- FR-4: links para o tutorial na entrada, no cabeçalho do app e na política de privacidade.
- FR-5: `pnpm tutorial:screenshots` sobe o servidor E2E em portas próprias, captura as telas, converte para WebP, grava em `apps/web/public/assets/tutorial/` com hash no nome e regenera `tutorial-images.generated.ts` (largura, altura, bytes). (BR-4)
- FR-6: Caddy serve `/tutorial` com `Cache-Control: no-cache` e CSP; `/assets/tutorial/*` com cache longo; o smoke confere a rota.

## Non-functional requirements
- NFR-1: peso total das imagens da página < 3 MB; imagens abaixo da dobra com `loading="lazy"` (a primeira do computador e a primeira do celular, não); `width`/`height` declarados (sem salto de layout).
- NFR-2: WCAG 2.2 AA: axe sem violações sérias em 1440 px e 390 px; sem rolagem horizontal em 390 px; alvos ≥ 44 px.
- NFR-3: textos em pt-BR externalizados com `i18n`.

## Acceptance criteria
- **AC-1 (FR-1, BR-1, NFR-2)**
  - Given uma pessoa sem sessão
  - When ela abre `/tutorial`
  - Then vê o título de nível 1 "Como usar a Nova Alexandria", o sumário e as seções, sem violações sérias do axe, em 1440 px e 390 px, sem rolagem horizontal
- **AC-2 (FR-2)**
  - Given o link `/tutorial#pesquisa-com-ia`
  - When a página abre
  - Then o título "Pesquisa com IA" está na tela e recebe o foco; clicar num item do sumário leva à seção dele
- **AC-3 (FR-3, BR-2)**
  - Given a lista de seções do sumário
  - When a página é montada
  - Then cada seção existe com a sua âncora, cada figura tem uma imagem do manifesto e um texto alternativo não vazio, e cada imagem carrega
- **AC-4 (FR-4)**
  - Given a tela de entrada, o cabeçalho do app e a política de privacidade
  - When a pessoa procura ajuda
  - Then encontra "Como usar" (entrada), o ícone "Como usar a Nova Alexandria (abre em nova aba)" (cabeçalho) e o link na política, todos para `/tutorial`
- **AC-5 (NFR-1)**
  - Given o manifesto de imagens
  - When se soma o tamanho
  - Then o total fica abaixo de 3 MB, e só as primeiras figuras do computador e do celular carregam sem `loading="lazy"`
- **AC-6 (FR-6)**
  - Given a produção
  - When o smoke roda
  - Then `/tutorial` responde 200 com a SPA, `Cache-Control: no-cache` e CSP
- **AC-7 (FR-5, BR-4)**
  - Given o servidor E2E
  - When se roda `pnpm tutorial:screenshots`
  - Then as imagens e o manifesto são regenerados sem dados reais (só `@exemplo.test` e o vault de fixture)

## Test strategy
- Unitário (web): `public-pages` reconhece `/tutorial`; a página tem cada âncora do sumário, figuras com alt e imagens do manifesto, peso total < 3 MB, só a primeira imagem sem lazy; links na entrada, no cabeçalho e na política.
- E2E: `/tutorial` sem sessão (axe, 1440/390, sem overflow), âncora direta com foco, sumário, todas as imagens carregam (`naturalWidth > 0`).
- Smoke: `/tutorial` no `deploy/scripts/smoke.sh`.

## References
- Telas: `docs/design/screens.md` (T13).
- Padrão de página pública: KBC-016 (`/privacidade`).

## Open questions
- Nenhuma.

## Definition of ready
- [x] Pedido literal e matriz em `work/KBC-032/request.md`
- [x] Critérios com teste associado
- [x] Dependências (KBC-029/030/031) conhecidas: capturas finais depois do merge delas
