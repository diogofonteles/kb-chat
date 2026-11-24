---
id: KBC-158
title: "Revisão do gabarito dentro do app: tela só de masters para aprovar, editar, remover e acrescentar aspectos"
status: ready
slice: complete-answers
outcome: o dono revisa as 15 perguntas do gabarito (e as que vierem) na tela, e a revisão vira um arquivo que um comando exporta para o JSON versionado, sem ninguém editar JSON à mão
depends_on: [KBC-138]
---

# KBC-158 — Revisão do gabarito dentro do app

Pedido do dono (2026-11-17): revisar as 15 perguntas do gabarito **dentro do app**, não lendo JSON. O KBC-138 BR-3 diz que o gabarito só muda com a revisão do dono; hoje o status do arquivo é "proposto, aguarda revisão do dono".

**Dependência de ordem:** o gabarito (`docs/research/answer-key/hermetismo.json`, `schemaVersion: 2`, 15 perguntas, cada uma com `aspects[]` e, em cada aspecto, `passages[]` com `doc`, `title`, `quote`, `authorship`, `author`, `central`) e o `agent-eval` que o lê estão na branch da trilha de pesquisa `feature/answers-eval-and-term-search` (worktree `kb-chat-answers-eval`). Este item só começa depois que essa branch estiver no `develop`.

## Story
Como dono, quero ver cada pergunta do gabarito, os aspectos esperados e os trechos que os sustentam, e decidir pergunta a pergunta, para confirmar o que a medição de completude vai cobrar.

## Scope
**In:** tela "Gabarito" em Configurações (só master); por pergunta: ver, aprovar, editar texto (pergunta, título do aspecto, palavras-chave), remover pergunta ou aspecto ou trecho, acrescentar aspecto (com trecho do vault); abrir a fonte de cada trecho; guardar a revisão; comando que exporta.
**Out:** rodar o eval pela tela; gabaritos de outros acervos (o seletor lista os arquivos que existirem); gerar perguntas novas (o comando de proposta do KBC-138 FR-3 segue por linha de comando).

## Business rules
- BR-1: só master vê a tela e usa a API; os demais recebem 403 (o gabarito expõe trechos do acervo inteiro, sem filtro de nível).
- BR-2: a revisão **nunca** altera o JSON versionado direto: a API grava um arquivo de revisão no diretório de estado (`<KB_CHAT_STATE_DIR>/answer-key-review/<acervo>.json`: o gabarito de base por hash, e por pergunta `decision` = `approved|edited|removed|pending`, os campos editados e os aspectos acrescentados, com quem e quando). O arquivo não vai para o backup do banco nem para o git.
- BR-3: o comando `pnpm --filter @kb-chat/api exec tsx src/scripts/answer-key-export.ts <acervo>` lê a base + a revisão e escreve o JSON no formato `schemaVersion: 2` com `status` = "revisado pelo dono" só quando **todas** as perguntas estão decididas; o dono confere o diff e faz o commit (BR-3 do KBC-138: o arquivo versionado só muda com revisão).
- BR-4: se o gabarito de base mudou depois da revisão (hash diferente), a tela avisa e mostra só as perguntas cuja base mudou como "pendentes de novo"; nenhuma decisão é descartada em silêncio.
- BR-5: um trecho acrescentado precisa existir no vault (documento e citação literal localizável); a API valida.
- BR-6: remover é reversível até exportar ("Desfazer"); a pergunta removida some do export, não da base.

## Functional requirements
- FR-1: `GET /api/v1/answer-key/:collection`: a base + a revisão mescladas, com contagens por decisão (master). (BR-1, BR-2)
- FR-2: `PUT /api/v1/answer-key/:collection/questions/:id`: grava decisão e edições da pergunta (zod em `libs/contracts`), gravação atômica do arquivo de revisão. (BR-2)
- FR-3: a tela lista as perguntas (assunto, pergunta, contagem de aspectos, selo da decisão) e abre uma de cada vez: pergunta, aspectos e seus trechos (autor, "central", citação), com "Abrir a fonte" no documento do vault (painel de leitura, KBC-127). (BR-1)
- FR-4: ações por pergunta: **Aprovar**, **Editar** (campos inline), **Remover**, **Acrescentar aspecto**; por aspecto: editar, remover, acrescentar trecho. (BR-5, BR-6)
- FR-5: indicador "X de 15 decididas" e botão "Exportar" que mostra o comando a copiar (a tela não escreve no repositório). (BR-3)
- FR-6: o comando de export e sua validação (zod do gabarito v2; falha se houver pergunta pendente, a menos que `--partial`). (BR-3)

## Acceptance criteria
- AC-1 (FR-1, BR-1, negativo): Given uma pessoa que não é master, When pede `GET /api/v1/answer-key/hermetismo`, Then 403; e a tela não aparece na navegação.
- AC-2 (FR-3): Given o gabarito de 15 perguntas, When o master abre a tela, Then vê 15 linhas, "0 de 15 decididas", e a primeira pergunta com seus aspectos e trechos.
- AC-3 (FR-4, FR-2): Given a pergunta "sete-principios", When aprovo, Then o selo vira "Aprovada", o contador sobe e o arquivo de revisão tem a decisão com quem e quando; recarregar mantém.
- AC-4 (FR-4): Given um aspecto, When edito o título e removo um trecho, Then a revisão guarda a edição e o export reflete.
- AC-5 (BR-5, negativo): Given um trecho acrescentado cuja citação não está no documento, Then 422 e nada é gravado.
- AC-6 (BR-3, FR-6): Given as 15 decididas, When rodo o comando, Then sai o JSON v2 com `status` "revisado pelo dono", só com as aprovadas e editadas, e o `agent-eval` o aceita.
- AC-7 (FR-6, negativo): Given 3 pendentes, When rodo o comando sem `--partial`, Then falha com a lista das pendentes e não escreve.
- AC-8 (BR-4, edge): Given o gabarito de base alterado depois de decidir 10, When abro a tela, Then vejo o aviso e as perguntas alteradas voltam a pendentes; as outras seguem decididas.
- AC-9 (BR-6, edge): Given uma pergunta removida, When desfaço antes de exportar, Then volta como estava.
- AC-10 (FR-3, UI): "Abrir a fonte" abre o documento no painel; em 1440 a revisão tem lista à esquerda e pergunta à direita; em 390 a lista vira uma tela e a pergunta outra, com ações alcançáveis (alvo ≥ 44 px), em Chromium e WebKit.
- AC-11 (concorrência, edge): Given duas abas gravando a mesma pergunta, Then a última gravação vence e a outra aba vê a diferença ao recarregar (arquivo atômico, sem corrupção).

## Test strategy
Unidade do mesclador base+revisão e do export (`answer-key-review.test.ts`); integração da API (403, 422, atomicidade) com o gabarito de fixture e o vault de fixture; spec da tela; E2E "Revisar o gabarito" em 1440 e 390, Chromium e WebKit.

## UI references
Figma `au1MI6z2Vwy9tnqOv2vrfH`: **frames novos** "v2 · Configurações — Gabarito" (lista + pergunta, 1440; lista e pergunta em telas separadas, 390; estados: pendente, aprovada, editando, removida, aviso de base alterada, erro de trecho inexistente). Entrada: Configurações de administração (KBC-132), seção "Pesquisa". T-nova em `docs/design/screens.md`.

## References
`docs/research/answer-key/hermetismo.json` (worktree `kb-chat-answers-eval`, branch `feature/answers-eval-and-term-search`) · KBC-138 · KBC-132 · KBC-127 · ADR 0004, 0013, 0021

## Decisões assumidas (o dono pode mudar)
- Armazenamento mais simples e seguro: arquivo de revisão no diretório de estado + comando de export; o repositório nunca é escrito pelo app.
- Tela só para master, dentro de Configurações de administração.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [ ] Dependencies done: **aguarda a branch `feature/answers-eval-and-term-search` no `develop`** (o gabarito e o `agent-eval` v2 estão lá)
- [x] Fits one goal
