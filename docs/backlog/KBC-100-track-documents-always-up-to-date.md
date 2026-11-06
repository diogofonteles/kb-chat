---
id: KBC-100
title: "Documentos das faixas sempre em dia: regerar, reclassificar e remover a cada mudança, fila visível com o Mac desligado e publicação automática na produção"
status: ready
slice: phase-2-research-media
outcome: nenhuma faixa fica fora da pesquisa ou com texto velho por mais de 40 min com o Mac ligado; quem edita sabe sempre em que pé a faixa está
depends_on: [KBC-099, KBC-073]
parent: KBC-098
---

# KBC-100 — Documentos das faixas sempre em dia

## Story
Como quem edita o acervo de áudio, quero que toda mudança numa faixa chegue sozinha à pesquisa com IA, e ver quando ela ainda não chegou, para nunca citar um texto velho nem uma faixa que tirei.

## Scope
**In:** reconciliação completa (ADR 0035 §4) ligada a todos os callbacks de mudança (`afterTranscript`, `afterRecordingEdit`, revisão de faixa do KBC-073, arquivar, restaurar, assuntos e resumo, nome de quem fala, autoria, acervo) e à transação de correção do KBC-093 quando ele entrar, mais a varredura de reserva de 10 min; `remove` ao arquivar, apagar, despublicar ou mover; documentos para as gravações transcritas sem faixas (preenchimento em lotes de 50; as faixas publicadas antes do KBC-099 passaram ao KBC-099, ver a nota de 2026-11-06); estado da publicação na página da faixa e em Transcritores; **Tentar de novo**; gasto do kb no livro da mídia com o teto mensal; sincronização automática Mac → produção e troca do índice sem parar a API.
**Out:** rodar o kb sem o Mac (fase 3, ADR 0031); mudar o kb; estado da publicação para quem só ouve.

## Business rules
- BR-1 (KBC-098 BR-5): qualquer mudança no que o documento mostra muda o fingerprint e gera `write`; nada mais gera.
- BR-2: arquivar, apagar, despublicar ou mover a faixa gera `remove` no caminho antigo (e `write` no novo acervo, ao mover); restaurar gera `write`.
- BR-3: um job pendente por acervo; um fingerprint mais novo substitui o do job na fila; um job já em curso termina e a diferença vai no próximo.
- BR-4: os estados da faixa são **Na pesquisa com IA**, **Atualizando na pesquisa**, **Aguardando o Mac do dono**, **Falhou: <motivo>** e **Fora da pesquisa** (acervo sem pasta no kb, teto mensal da mídia); só "Na pesquisa" quer dizer que o catálogo de produção vê o fingerprint atual.
- BR-5: com o Mac desligado, os jobs esperam; ao voltar, retomam sem ação; 4 tentativas e depois **Falhou** com o erro.
- BR-6 (KBC-098 BR-7): o gasto do kb entra no livro da mídia; com o teto mensal atingido, nada novo é publicado e o estado diz "Fora da pesquisa: teto mensal da mídia".
- BR-7: a sincronização automática roda no máximo a cada 30 min, só com mudança pendente, nunca durante um deploy (trava de `deploy.sh`), com o limite de remoções de `sync-vault.sh`; a troca do índice reinicia só o `qmd mcp` da API.

## Functional requirements
- FR-1: Cada callback de mudança deve chamar a reconciliação da faixa (ou da gravação inteira); a varredura de 10 min deve reconciliar tudo. (BR-1, BR-2)
- FR-2: A correção do KBC-093 deve reconciliar, na mesma transação, as faixas que contêm a palavra. (BR-1)
- FR-3: A página da faixa (para `media-edit`) e Transcritores (para masters) devem mostrar o estado do BR-4, com "desde <hora>" e **Tentar de novo** em **Falhou**. (BR-4, BR-5)
- FR-4: O transcritor deve rodar `sync-vault.sh` depois de um lote, no intervalo do BR-7, e registrar o resultado no relatório do job. (BR-7)
- FR-5: `install-index.sh --hot` deve trocar o índice e avisar a API por um arquivo-gatilho; a API deve reiniciar só o processo `qmd mcp` e responder pela reserva `kb search` durante a troca. (BR-7)
- FR-6: A API deve marcar `published_at` quando o catálogo de produção vê o `kb_chat_fingerprint` desejado. (BR-4)
- FR-7: Um preenchimento deve enfileirar, em lotes de 50 por acervo, as gravações sem faixas que não têm documento. (KBC-098 AC-2)

*Nota 2026-11-06:* as faixas publicadas antes do KBC-099 saíram deste item: o dono aprovou trazê-las ao KBC-099 ("pode fazer como sugeriu"), como a ação de master **Publicar no acervo as faixas que já existem** (KBC-099 FR-11, AC-16). Aqui fica só o preenchimento das gravações sem faixas.

## Non-functional requirements
- NFR-1: com o Mac ligado, mudança → **Na pesquisa** em produção em p95 ≤ 40 min (20 mudanças de tipos variados).
- NFR-2: a troca do índice não derruba turnos de pesquisa em curso (0 turnos interrompidos em 10 trocas com um turno longo rodando) e deixa a busca "degradada" ≤ 10 s.
- NFR-3: o preenchimento de 2.000 h em faixas cabe numa noite (≤ 8 h) no Mac do dono e custa ≤ US$ 4 (recibos do kb).

## Acceptance criteria
- **AC-1** (BR-1, FR-1): Given uma faixa publicada, When o título muda, Then um `write` sai com o título novo e, depois do job, `find_text` acha o título novo e não o velho.
- **AC-2** (BR-1, FR-1): Given uma faixa, When os limites mudam (KBC-073), Then o documento tem o texto do intervalo novo e âncoras recalculadas.
- **AC-3** (BR-1, FR-1): Given uma gravação re-transcrita, When a versão nova é guardada, Then todas as faixas dela são regeradas e reclassificadas.
- **AC-4** (BR-1, FR-2): Given o KBC-093 no `develop`, When uma palavra é corrigida numa faixa, Then só as faixas com aquela palavra ganham `write`, e a pesquisa acha a palavra corrigida.
- **AC-5** (BR-2): Given uma faixa publicada, When é arquivada, Then sai da pesquisa na hora (KBC-099 AC-7) e um `remove` apaga o arquivo; When é restaurada, Then volta.
- **AC-6** (BR-2, borda): Given uma gravação movida para outro acervo, Then o documento sai da pasta antiga e entra na nova, e a pesquisa no acervo antigo não o acha mais.
- **AC-7** (BR-5, FR-3): Given o Mac desligado há 2 h, When uma faixa muda, Then a página mostra "Aguardando o Mac do dono (desligado desde 14:02)"; When o Mac volta, Then o estado passa a **Atualizando** e depois **Na pesquisa com IA** sem ninguém agir.
- **AC-8** (FR-7): Given uma gravação transcrita sem faixas, When o preenchimento roda, Then ela ganha documento. (As faixas antigas: KBC-099 AC-16.)
- **AC-9** (BR-3): Given 10 mudanças na mesma faixa em 1 min, Then sai no máximo um job em curso e um na fila, e o documento final tem o último estado.
- **AC-10** (BR-5, negativo): Given o kb falhando 4 vezes, Then o estado é **Falhou: <saída do kb resumida>**; **Tentar de novo** enfileira de novo.
- **AC-11** (BR-6, negativo): Given o teto mensal da mídia atingido, Then nenhum job sai e o estado diz "Fora da pesquisa: teto mensal da mídia".
- **AC-12** (BR-1 exceção do KBC-098): Given um acervo criado na tela sem pasta no vault, Then o estado diz "Fora da pesquisa: o acervo ainda não tem pasta no kb" e nenhum job sai.
- **AC-13** (BR-7, FR-4, FR-5): Given uma mudança publicada, When a sincronização roda, Then a API não reinicia, um turno de pesquisa em curso termina e o catálogo de produção vê o fingerprint novo.
- **AC-14** (BR-7, negativo): Given um deploy em curso, Then a sincronização espera a trava e não roda junto.
- **AC-15** (acessibilidade): Given o estado na página da faixa, Then ele é texto (não só cor), anunciado em `role="status"` quando muda, e cabe em 390 px.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-6, AC-9, AC-11, AC-12 | integração | `media-documents.integration.test.ts`: cada tipo de mudança → `write`/`remove`, coalescência |
| AC-4 | integração | ativo só quando o KBC-093 estiver no `develop` (o teste fica no item que chegar por último) |
| AC-7, AC-10 | integração + componente | estados com relógio falso; `track-publication-status.spec.ts` |
| AC-8 | integração | preenchimento em lotes |
| AC-13, AC-14 | script + staging | `install-index.sh --hot` no smoke local de imagens (runbook); evidência em `work/KBC-100/` |
| AC-15 | componente + E2E | `media-track-revisions.spec.ts` estendido |

## References
ADR [0035](../adr/0035-tracks-as-kb-documents.md) §4, §9–§11 · KBC-093 / ADR 0034 (ramo `feature/correct-transcript-words`) · Runbook `docs/deploy/runbook.md` §7 e §10 · Tela T22 (estado da publicação).

## Open questions
- Intervalo da sincronização automática: 30 min (padrão) — dono. Não bloqueia.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR e tela
- [x] Depende do KBC-099
- [x] Cabe num goal
