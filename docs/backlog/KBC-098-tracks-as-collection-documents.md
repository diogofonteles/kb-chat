---
id: KBC-098
title: "Faixas transcritas como documentos do acervo: classificadas pelo kb como os textos, pesquisáveis pela IA, e a referência abre a transcrição com o player"
status: split
slice: phase-2-research-media
outcome: quem pesquisa com IA recebe faixas entre as fontes e ouve o trecho citado com um clique; meta ≥ 30 % das respostas sobre um acervo com faixas citam ao menos uma faixa, e ≥ 50 % das faixas citadas são abertas
depends_on: [KBC-068, KBC-069, KBC-008, KBC-017, KBC-020, KBC-030, KBC-038, KBC-045]
split_into: [KBC-099, KBC-100, KBC-101]
---

# KBC-098 — Faixas transcritas como documentos do acervo

Pedido do dono (2026-11-05, prioridade) e o complemento ("usar o kb para fazer o index e classificacao"): [`work/KBC-098/request.md`](../../work/KBC-098/request.md) no worktree do item; o texto do cartão está transcrito abaixo. Decisão de arquitetura: [ADR 0035](../adr/0035-tracks-as-kb-documents.md), que substitui o §4 da ADR 0024.

## Story
Como quem estuda o acervo, quero que cada faixa transcrita seja um documento do acervo, classificado como os textos, para que a pesquisa com IA me responda também com o que foi falado, me mostre a faixa e o minuto e me deixe ouvir o trecho ao lado da transcrição.

## O cartão (7 pontos) → onde cada um é entregue
| # | Ponto do cartão | Item | AC |
|---|---|---|---|
| 1 | Toda faixa transcrita vira, por padrão e sem ação manual, um documento do acervo da coleção da gravação, com título, autoria, coleção, link para a faixa e tempos por trecho | KBC-099 (faixas novas), KBC-100 (as que já existem e gravações sem faixas) | AC-1, AC-2 |
| 2 | Mesmo caminho dos textos pelo kb: index (QMD), `kb classify` e `kb link` | KBC-099 | AC-3 |
| 3 | Sempre em dia: edição, re-transcrição, correção de palavra (KBC-093) regeneram, reindexam e reclassificam; apagar ou despublicar remove; Mac desligado = fila com estado visível que retoma sozinha | KBC-100 | AC-4, AC-5, AC-6 |
| 4 | Pesquisável pela IA (Rápido, Profundo, Exaustivo com sub-pesquisa), com permissões de acervo e filtro de autoria; a cobertura do Exaustivo conta as faixas | KBC-099 (Rápido e Profundo), KBC-101 (Exaustivo, cobertura, filtros, sub-acervos) | AC-7, AC-8, AC-9 |
| 5 | Faixas nas fontes da resposta ao lado dos textos, com ícone de áudio, título, gravação e minuto | KBC-099 | AC-10 |
| 6 | O clique abre a transcrição no painel de leitura, rolada até o trecho destacado, e o player ao lado em −2 s, pronto para tocar, com a palavra falada destacada; 390 px sem rolagem lateral; teclado e leitor de tela | KBC-099 | AC-11, AC-12 |
| 7 | Nada fora da conversa piora (Biblioteca, player, busca por faixa KBC-096, assuntos KBC-069/070) | KBC-099 (regressão), KBC-101 ("Veja também" com faixas) | AC-13 |
| 8 | Decisão do dono de 2026-11-07: "cada faixa transcrita é um documento do acervo" também na busca de documentos (T2): na lista, nas facetas e nas contagens, com ♪, abrindo o T22, sem repetir o que "Na fala" já mostra | KBC-101 | AC-14 |

## Scope
**In:** documento por faixa publicada (e por gravação transcrita sem faixas) escrito no vault pelo Mac do dono; `kb classify`, `kb link` e `kb index` por padrão; reconciliação que mantém o documento em dia; visibilidade decidida pelo `media.db`; ferramentas e varredura da pesquisa com faixas; citação com faixa e milissegundos; painel com transcrição e player; estado da publicação visível; publicação automática em produção; permissão nova `media-research` ("Pesquisar faixas com IA").
**Out:** mostrar o Markdown do vault às pessoas (o painel mostra a transcrição do `media.db`); rodar o kb no servidor (fase 3, ADR 0031); vídeo (KBC-075 segue a mesma regra depois); confirmação humana da classificação do kb (o dono decidiu em 2026-11-07 que não há). As faixas na lista de documentos da busca (T2) ficaram fora do KBC-099 e entram no KBC-101 (decisão do dono de 2026-11-07).

## Business rules
- BR-1: toda faixa pronta, publicada e não arquivada tem exatamente um documento no vault, na pasta do acervo da gravação; uma gravação transcrita sem faixas tem um documento inteiro. Exceção: acervo sem pasta no vault (criado na tela e ainda sem `kb topic new`) fica em "Falhou: acervo sem pasta no kb" até a pasta existir.
- BR-2: a API nunca escreve no vault nem no índice (Q7); só o Mac do dono, por um transcritor marcado **Publica no acervo**, escreve, classifica, liga e indexa.
- BR-3: a classificação do kb roda sozinha, sem confirmação; os assuntos aceitos no KBC-069 continuam valendo e entram no documento.
- BR-4: o `media.db` decide quem vê: uma faixa entra na pesquisa só se existe, está pronta, não arquivada, no mesmo acervo, e a pessoa tem acesso ao acervo, `research`, `media` e `media-research`. Apagar ou arquivar tira da pesquisa na hora, antes do vault mudar.
- BR-5: qualquer mudança no que o documento mostra (transcrição nova, correção de palavra, título, limites, quem fala, autoria, assuntos, acervo) gera um documento novo, reclassificado e reindexado.
- BR-6: a citação de uma faixa guarda a faixa e o trecho em milissegundos do `media.db`, no relógio da faixa; o minuto nunca é inventado pelo modelo (ADR 0035 §6).
- BR-7: o gasto do kb vai para o livro da mídia e respeita o teto mensal da mídia; a pesquisa sobre faixas gasta como a pesquisa sobre textos, na política de IA de cada pessoa (ADR 0016).
- BR-8: a autoria do documento é a da mídia (`mestre-laercio` ou `outros-autores`, ADR 0015) e o autor é o do acervo (ADR 0030); a IA nunca mistura os dois grupos, como nos textos.

## Non-functional requirements
- NFR-1: com o Mac ligado, faixa aprovada → citável na pesquisa da API local em p95 ≤ 10 min; em produção, ≤ 40 min (intervalo de sincronização de 30 min incluído). Medido pelo tempo entre `approved_at` e `published_at` em `media_documents` em 20 faixas.
- NFR-2: classificar, ligar e indexar custa ≤ US$ 0,002 por faixa (recibos do kb, 2 gravações de teste do KBC-063).
- NFR-3: a pesquisa não fica mais lenta: `search_collection` e `find_text` p95 no máximo +10 % com 2.000 faixas a mais no acervo de teste.
- NFR-4: clique na citação → painel com o trecho visível e o player posicionado em p95 ≤ 1 s (local, faixa de 30 min).
- NFR-5: 390 px sem rolagem lateral; WCAG 2.2 AA, axe sem violações sérias nos três temas.

## Acceptance criteria (do cartão; os detalhes testáveis estão nos itens filhos)
- **AC-1** (BR-1, ponto 1): Given uma faixa recém-aprovada num acervo com pasta no kb e o transcritor com **Publica no acervo** ligado, When o Mac pega a fila, Then existe um documento dela no vault com título, autoria, autor, acervo, `kb_chat_media_id` e âncoras de tempo, sem nenhuma ação manual. → KBC-099 AC-1, AC-2
- **AC-2** (BR-1, ponto 1): Given faixas publicadas antes deste item e uma gravação transcrita sem faixas, When o KBC-100 entra, Then todas ganham documento sem ação manual. → KBC-100 AC-8
- **AC-3** (BR-2, BR-3, ponto 2): Given o documento escrito, Then `kb classify`, `kb link` e `kb index` rodaram para o acervo, e o catálogo lê dele `genre`, `depth`, `relevance`, `concepts` e relações como de um texto. → KBC-099 AC-3
- **AC-4** (BR-5, ponto 3): Given uma faixa publicada, When muda o título, os limites, a transcrição ou uma palavra (KBC-093), Then o documento é regerado, reclassificado e reindexado, e a pesquisa passa a achar o texto novo. → KBC-100 AC-1 a AC-4
- **AC-5** (BR-4, ponto 3): Given uma faixa publicada, When é arquivada, apagada ou movida de acervo, Then some da pesquisa na hora e o documento sai do vault (ou muda de pasta) na próxima publicação. → KBC-100 AC-5, AC-6
- **AC-6** (ponto 3): Given o Mac desligado, When uma faixa muda, Then a página da faixa mostra "Aguardando o Mac do dono" e, quando o Mac volta, a publicação acontece sozinha. → KBC-100 AC-7
- **AC-7** (BR-4, ponto 4): Given uma pergunta respondida pelo que só foi falado numa faixa, When a pessoa pesquisa no Rápido ou no Profundo, Then a resposta cita a faixa. → KBC-099 AC-5
- **AC-8** (BR-4, BR-8, ponto 4): Given alguém sem `media-research`, sem `media` ou sem acesso ao acervo, Then nenhuma ferramenta mostra faixas; com o filtro de autoria, só faixas daquele grupo. → KBC-099 AC-6, AC-7; KBC-101 AC-3
- **AC-9** (ponto 4): Given o Exaustivo num acervo com textos e faixas, Then a varredura lê as faixas e a cobertura diz quantos documentos e quantas faixas. → KBC-101 AC-1, AC-2
- **AC-10** (BR-6, ponto 5): Given uma resposta que cita uma faixa, Then "Fontes" mostra o chip com ♪, título da faixa, gravação e minuto, ao lado dos textos. → KBC-099 AC-8
- **AC-11** (ponto 6): Given o clique numa citação de faixa, Then o painel mostra a transcrição rolada até o trecho destacado e, ao lado, o player 2 s antes, pausado; ao tocar, a palavra falada se destaca. → KBC-099 AC-9, AC-10
- **AC-12** (NFR-5, ponto 6): Given 390 px, só teclado ou leitor de tela, Then tudo funciona sem rolagem lateral. → KBC-099 AC-11, AC-12
- **AC-13** (ponto 7): Given os testes da Biblioteca, do player, do KBC-096 e dos assuntos, Then continuam passando sem mudança; no KBC-099 a busca de documentos (T2) ainda não mostra faixas na lista de textos. → KBC-099 AC-13
- **AC-14** (ponto 8): Given um acervo com textos e faixas publicadas, When alguém que pode ver as faixas busca em "Buscar documentos", Then as faixas aparecem na lista de documentos com ♪, entram nas facetas e nas contagens como qualquer documento, cada faixa uma vez só (sem repetir o cartão "Na fala" dela), e o clique abre o T22. → KBC-101 AC-10 a AC-20

## Test strategy
Em cada item filho. O E2E de ponta a ponta (pergunta → citação de faixa → painel com player) entra no KBC-099 e é estendido no KBC-101.

## References
ADR [0035](../adr/0035-tracks-as-kb-documents.md) (substitui o §4 da [0024](../adr/0024-media-search-outside-the-vault.md)); [0003](../adr/0003-facets-from-frontmatter-catalog.md), [0015](../adr/0015-authorship-in-catalog-and-tool-contracts.md), [0016](../adr/0016-house-ai-plan-and-access-policy.md), [0021](../adr/0021-app-driven-exhaustive-sweep.md), [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md), [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md), [0030](../adr/0030-authors-per-collection.md); KBC-093 (ADR 0034, no ramo dele). Tela: T22 em `docs/design/screens.md` e emenda na T4.

## Open questions
Resolvidas em 2026-11-07 (dono, conversa). As perguntas de `work/KBC-098/spec.md` §Perguntas ficaram assim:
1. Classificação do kb sem confirmação: **sim**, `kb classify`/`kb link` automáticos (padrão aprovado).
2. `media-research` não liga sozinha para quem já tem `research` e `media`: masters têm; o master concede em Pessoas e permissões ou num perfil de convite (padrão aprovado).
3. Player ao abrir a citação: **pausado em −2 s**, pronto para tocar (padrão aprovado).
4. Gravação transcrita sem faixas vira **um documento** da gravação inteira (KBC-100; padrão aprovado).
5. Faixas na lista de documentos da busca (T2): **sim, mudou.** O dono: "as faixas devem aparecer na lista de documentos, cada faixa transcrita é um «documento» do acervo". Entram na lista, nas facetas e nas contagens como qualquer documento do acervo, com ♪, abrindo o T22 com o player. Vai para o KBC-101 (ponto 8, AC-14); emenda na ADR 0035 e nas telas T2 e T22.
6. Transcrição de baixa confiança: **entra** na pesquisa, marcada "confiança baixa" para a IA e no chip (padrão aprovado).
7. Sincronização automática com a produção: **a cada 30 min** (KBC-100; padrão aprovado).

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada ponto do cartão e cada BR com AC, mapeados para os itens filhos
- [x] NFRs medidos
- [x] Nível de teste em cada AC (nos filhos)
- [x] Tela e ADR ligadas
- [x] Dependências feitas ou agendadas (KBC-093 entra quando estiver pronto: a reconciliação já o cobre)
- [x] Dividido: não cabe num goal
