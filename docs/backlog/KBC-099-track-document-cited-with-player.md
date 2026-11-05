---
id: KBC-099
title: "Faixa vira documento do acervo pelo kb e a IA a cita: a referência abre a transcrição no trecho com o player ao lado (esqueleto)"
status: ready
slice: phase-2-research-media
outcome: uma faixa aprovada é citada pela pesquisa com IA (Rápido e Profundo) e o clique leva ao trecho com o player pronto; prova o caminho inteiro Mac → kb → catálogo → agente → citação → painel
depends_on: [KBC-068, KBC-069, KBC-008, KBC-011, KBC-020, KBC-038, KBC-045]
parent: KBC-098
---

# KBC-099 — Faixa como documento, citada com o player (esqueleto)

## Story
Como quem estuda, quero perguntar à IA e receber, entre as fontes, a faixa onde aquilo foi dito, para abrir a transcrição no trecho e ouvir de lá, ao lado.

## Scope
**In:**
- Renderizador do documento da faixa (ADR 0035 §2) e tabela `media_documents` (migração do `media.db`).
- Reconciliação mínima: faixa publicada que ainda não tem documento, ou cujo fingerprint mudou no momento da publicação (`TrackPublisher` ao publicar), enfileira `kb-publish`; varredura de reserva a cada 10 min.
- Job `kb-publish` (contrato em `libs/contracts`, rotas do worker) e o passo no transcritor do Mac: opção **Publica no acervo** em Transcritores, caminho do vault na configuração, trava, escrita do arquivo, `kb classify`, `kb link`, `kb index` com `--budget`, relatório por documento (caminho, facetas, gasto).
- Spike no começo do item, no binário real do kb 0.0.12 sobre uma cópia do vault: `kb classify` e `kb link` processam um arquivo em `raw/media/` que não passou pelo `kb ingest`, preservam as âncoras e as chaves `kb_chat_*`. Se não, entra a alternativa 5 da ADR 0035 (`kb ingest file --force`, com o caminho gerado pelo kb guardado em `media_documents`), registrada como decisão.
- Catálogo: `CatalogEntry.media` a partir das chaves `kb_chat_*`; `origin: audio`.
- Filtro de visibilidade pelo `media.db` (ADR 0035 §5) em todas as ferramentas da pesquisa, e exclusão das faixas da lista de documentos da busca (T2), das contagens de facetas e do "Veja também".
- Permissão nova `media-research` ("Pesquisar faixas com IA"), em "Pessoas e permissões", nos perfis de convite e no "Ver como" (KBC-060); masters a têm.
- Saída das ferramentas para faixas (tipo, gravação, faixa n de N, autor, autoria, confiança) com as âncoras; instrução no prompt para citar `[n@m:ss]`.
- Contrato `answerSourceSchema.media` e `.passages` (aditivo) e a resolução do trecho (ADR 0035 §6 a, b).
- Web: `[n@m:ss]` vira link; chip da fonte com ♪, título da faixa, gravação e minuto; painel "Trecho da faixa" (T22) com a transcrição rolada até o trecho destacado e o player ao lado, em −2 s, pausado.
**Out:** regerar e remover documentos em toda mudança, estado visível da publicação, documentos das faixas antigas e das gravações sem faixas, sincronização automática com a produção (KBC-100); Exaustivo, cobertura, filtro de origem "Faixas", sub-acervos nas ferramentas de leitura, faixas no "Veja também" (KBC-101); mostrar o Markdown do vault.

## Business rules
- BR-1 (KBC-098 BR-1, BR-2): só o transcritor marcado **Publica no acervo** recebe `kb-publish`; a API nunca escreve no vault.
- BR-2: o documento é determinístico: a mesma faixa no mesmo estado gera o mesmo arquivo e o mesmo fingerprint.
- BR-3 (KBC-098 BR-3): a classificação do kb não pede confirmação.
- BR-4 (KBC-098 BR-4): uma entrada de faixa só aparece numa ferramenta se o `media.db` a confirma (existe, pronta, não arquivada, mesmo acervo) e a pessoa tem acesso ao acervo, `research`, `media` e `media-research`.
- BR-5 (KBC-098 BR-6): o trecho citado vem do `media.db`: o tempo escrito pelo modelo só vale se a âncora foi mostrada a ele nesta resposta, para aquela fonte; senão vale o último trecho que as ferramentas mostraram dela; sem nenhum, o começo da faixa.
- BR-6 (KBC-098 BR-8): a autoria e o autor do documento são os da mídia; as ferramentas os mostram como nos textos.
- BR-7: a busca de documentos (T2), suas facetas e o "Veja também" não mostram documentos de faixa; "Na fala", a Biblioteca e os assuntos não mudam.

## Functional requirements
- FR-1: Quando uma faixa é publicada (KBC-068), o sistema deve renderizar o documento e enfileirar `kb-publish` para o acervo dela, coalescendo num só job por acervo. (BR-1, BR-2)
- FR-2: `POST /api/v1/media-worker/jobs/lease` deve entregar `kb-publish` só a um transcritor com `publishes: true`; `POST /jobs/:id/kb-result` deve receber, por documento, `{ path, ok, error?, facets?, spendUsd }`. (BR-1)
- FR-3: O transcritor deve escrever os arquivos sob `<vault>/<topic>/raw/media/`, rodar `kb classify <topic>`, `kb link <topic>`, `kb index --topic <topic>` com `--budget`, e falhar o job com a saída do kb quando um passo sair com erro. (BR-1, BR-3)
- FR-4: O catálogo deve ler `kb_chat_*` em `CatalogEntry.media` e o filtro de visibilidade deve esconder a entrada nos casos do BR-4. (BR-4)
- FR-5: `search_collection`, `find_text`, `read_document(s)`, `list_sources` e `related_documents` devem mostrar uma faixa com "faixa de áudio", gravação, "faixa n de N", autor, autoria, "transcrição automática" (e "confiança baixa" quando for) e as âncoras no texto. (BR-6)
- FR-6: O `SourceBook` deve guardar, por fonte de faixa, as âncoras mostradas e o último trecho mostrado; ao terminar a resposta, o sistema deve resolver cada `[n@m:ss]` e cada `[n]` de faixa em `passages[{ at, startMs, endMs }]` e o evento `sources` deve trazer `media`. (BR-5)
- FR-7: A web deve tornar `[n@m:ss]` um link "Fonte n, faixa <título>, aos m minutos e s segundos", e mostrar o chip da fonte com ♪, título, gravação e o primeiro minuto citado. (BR-5)
- FR-8: Clicar num link ou chip de faixa deve abrir o painel T22: transcrição atual do `media.db` com o trecho destacado e rolado para a vista, e o player da faixa carregado em `startMs − 2 s`, pausado. (BR-5)
- FR-9: A busca (T2) deve excluir entradas com `media` da lista de documentos, das contagens e do "Veja também". (BR-7)
- FR-10: A permissão `media-research` deve existir no contrato, na tela "Pessoas e permissões", nos perfis de convite e valer em "Ver como". (BR-4)

## Non-functional requirements
- NFR-1: faixa aprovada → citável na API local em p95 ≤ 10 min com o Mac ligado (20 faixas, `published_at − approved_at`).
- NFR-2: kb ≤ US$ 0,002 por faixa (recibos do kb nas 2 gravações de teste do KBC-063).
- NFR-3: `search_collection` e `find_text` p95 no máximo +10 % com 2.000 documentos de faixa sintéticos no vault de teste (`pnpm --filter @kb-chat/api latency`).
- NFR-4: clique → trecho visível e player posicionado em p95 ≤ 1 s (faixa de 30 min, local).
- NFR-5: barra de qualidade da fase 2 (cobertura ≥ 90 % no código novo de mídia; mutação ≥ 80 % no renderizador e na resolução do trecho; specs de mídia 3 vezes seguidas no Chrome).

## Acceptance criteria
- **AC-1** (FR-1, BR-2): Given uma faixa "O que é o ritmo?" (faixa 3 de 12, 1:12 a 9:40 da gravação) com 4 falas, When é publicada, Then o documento renderizado tem as chaves `kb_chat_*`, `author_group`, `author`, `# O que é o ritmo?`, a linha "Gravação: …" e um parágrafo por fala com âncora no relógio da faixa (`[0:00]`, `[0:41]` …); renderizar de novo dá o mesmo fingerprint.
- **AC-2** (FR-2, FR-3, BR-1): Given um transcritor sem **Publica no acervo**, When pede trabalho, Then nunca recebe `kb-publish`; Given um com a opção, When termina, Then o arquivo está em `<topic>/raw/media/<gravação>/<faixa>.md` e `media_documents.published_fingerprint` = o desejado.
- **AC-3** (FR-3, BR-3): Given o kb falso do teste do worker, Then os três passos rodam nessa ordem, para aquele acervo, com `--budget`; Given o kb real no spike, Then o documento recebe `genre`, `depth`, `relevance`, `concepts`, `summary` e relações, e as âncoras e chaves `kb_chat_*` continuam lá.
- **AC-4** (FR-3, negativo): Given `kb classify` saindo com erro, When o job roda, Then o job falha com a saída do kb, o arquivo escrito fica (o próximo job reclassifica) e a tentativa conta para o limite de 4.
- **AC-5** (FR-4, FR-5, FR-6): Given o vault de teste com o documento da faixa e o LLM stub que pesquisa "ritmo" e cita `[1@0:41]`, When alguém com `research`, `media` e `media-research` pergunta no Rápido, Then a resposta tem uma fonte com `media.mediaId` da faixa e `passages[0]` com `startMs`/`endMs` da fala que começa em 0:41 no `media.db`.
- **AC-6** (BR-4, permissão): Given alguém sem `media-research` (ou sem `media`, ou sem acesso ao acervo), When pergunta o mesmo, Then nenhuma ferramenta lista, lê ou acha a faixa e as fontes não a trazem.
- **AC-7** (BR-4, borda): Given a faixa arquivada depois de publicada (o arquivo ainda no vault), When alguém pesquisa, Then a faixa não aparece.
- **AC-8** (BR-5, FR-6, FR-7, negativo): Given o stub citando `[1@7:77]` (âncora nunca mostrada), Then o trecho resolvido é o último mostrado daquela fonte, nunca 7:77; Given `[1]` sem tempo, Then o mesmo; o chip mostra "♪ O que é o ritmo? · <gravação> · 0:41".
- **AC-9** (FR-8): Given a resposta com a faixa, When a pessoa clica em `[1@0:41]`, Then o painel abre com o título da faixa focado, a fala de 0:41 destacada e visível sem rolar, e o player em 0:39, pausado, com **Tocar** pronto.
- **AC-10** (FR-8): When a pessoa toca, Then o áudio sai de 0:39, a palavra falada se destaca (KBC-045) e a transcrição segue a fala; o mini-player some enquanto o painel mostra o mesmo áudio e volta ao fechar.
- **AC-11** (NFR-5 do KBC-098): Given 390 px, Then o painel ocupa a tela, a transcrição e o player cabem sem rolagem lateral, o player fica preso no alto do painel e o trecho aparece abaixo dele.
- **AC-12** (acessibilidade): Given só o teclado, Then Enter na citação abre o painel, Tab chega a **Tocar**, Esc fecha e o foco volta à citação; o leitor de tela ouve "Trecho da faixa O que é o ritmo?, aos 41 segundos"; com movimento reduzido, a rolagem é instantânea; axe sem violações sérias nos três temas.
- **AC-13** (BR-7, FR-9, regressão): Given o vault com documentos de faixa, When alguém busca "ritmo" em "Buscar documentos", Then a lista de textos e as contagens são as mesmas de sem eles e a faixa aparece só em "Na fala"; os specs `media-library-search`, `media-search`, `media-subjects`, `media-track-items` e `media-player` passam sem mudança.
- **AC-14** (FR-10): Given um master, Then `media-research` aparece marcado; Given um perfil de convite, Then a caixa "Pesquisar faixas com IA" existe e começa desmarcada.
- **AC-15** (borda): Given uma resposta salva antes deste item, When reaberta do histórico, Then as fontes aparecem como antes.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 | unidade + propriedade | `track-document.test.ts` (fast-check: ordem, âncoras, determinismo); mutação ≥ 80 % |
| AC-2, AC-4 | integração | `kb-publish.integration.test.ts` (fila, lease por capacidade, resultado) |
| AC-3 | unidade (worker) + spike manual | `tools/transcriber/tests/test_kb_publish.py` com kb falso; spike no kb real em cópia do vault, evidência em `work/KBC-099/evidence/` |
| AC-5 a AC-8 | integração | `research-tracks.integration.test.ts` no vault de fixture com um documento de faixa e `media.db` semeado, LLM stub; `passage-resolution.test.ts` (mutação ≥ 80 %) |
| AC-9 a AC-12 | componente + E2E | `track-passage-panel.spec.ts`; `e2e/specs/research-tracks.spec.ts` (Chrome, áudio real gerado por ffmpeg, `--repeat-each=3`, 1440 e 390) |
| AC-13 | integração + E2E existentes | `search.integration` com documentos de faixa; specs de mídia sem mudança |
| AC-14, AC-15 | componente | `people-editor.spec.ts`, `research-message.spec.ts` |
| NFR-3 | script | `latency` com 2.000 faixas sintéticas |

## References
ADR [0035](../adr/0035-tracks-as-kb-documents.md) · Tela T22 e emenda da T4 em `docs/design/screens.md` · Spec: `work/KBC-098/spec.md` · Pai: [KBC-098](KBC-098-tracks-as-collection-documents.md).

## Open questions
Perguntas ao dono com padrão adotado (não bloqueiam): ver `work/KBC-098/spec.md` §Perguntas.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] Tela e ADR
- [x] Dependências feitas (KBC-068, KBC-069, KBC-045 no `develop`)
- [x] Cabe num goal (o risco do kb fica no spike do começo, com a alternativa já decidida)
