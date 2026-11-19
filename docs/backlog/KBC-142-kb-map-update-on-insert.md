---
id: KBC-142
title: "Mapa do acervo (4): todo documento que entra (texto ou faixa) compõe o mapa sozinho, junto com os outros"
status: ready
slice: complete-answers
outcome: o mapa nunca fica para trás: ao inserir um texto ou publicar uma faixa, as seções, os assuntos e os dossiês tocados são atualizados antes de a produção receber o documento
depends_on: [KBC-141]
---

# KBC-142 — Mapa atualizado ao inserir

## Story
Como dono, quando insiro um documento novo no Hermetismo, quero que ele entre no mapa mental junto com todos os outros, sem um passo manual a mais, para que as respostas do Profundo já o considerem.

## Scope
**In:**
- `kb-map update <topic> --docs <paths>`, que faz em ordem:
  - as seções dos documentos novos ou mudados;
  - a atribuição à árvore, com os nós novos propostos para a revisão;
  - os dossiês **só dos nós tocados**: os artigos do wiki que o `kb lint` marcou como `needs-compile` pelas relações `affects` (padrão de wiki compilado, análise §2a), mais a linha do `log.md` e do `index.md`;
  - o `check`;
- o comando único para texto: `tools/kb-map add <topic> <file>`, que roda ingest, classify, link, update, index e sync;
- o job `kb-publish` do transcritor (ADR 0035), que roda o `update` dos documentos do lote antes do sync;
- o documento apagado: suas seções saem dos nós e dos dossiês;
- o estado "pendente no mapa" no catálogo da API.

**Out:** inserir textos pela tela do app (hoje é no Mac); a resposta usar o pendente (KBC-144 faz isso).

## Business rules
- BR-1: um documento só chega à produção com o mapa atualizado ou marcado "pendente no mapa"; nunca com um mapa que diz outra coisa (check do KBC-141).
- BR-2: o update toca só os nós das seções novas, mudadas ou removidas. Os outros dossiês ficam como estão, byte a byte.
- BR-3: se o update falha (modelo fora, cota), o documento vai assim mesmo, marcado "pendente no mapa", e o update é tentado de novo no próximo job.
- BR-4: apagar um documento remove as suas seções do mapa no mesmo sync.
- BR-5 (dono, 2026-11-16): uma faixa de áudio, depois de transcrita, recebe **o mesmo tratamento de um documento de texto**: as mesmas etapas (classify, link, index, mapa) e os mesmos dossiês, sem regra própria. A única diferença é técnica: as seções de uma faixa começam e terminam numa âncora de tempo `[m:ss]`, para a citação abrir o player no ponto certo. Corrigir a transcrição ou editar a faixa reescreve o documento, e o mapa é atualizado como na edição de um texto.

## Functional requirements
- FR-1: `kb-map update` deve aplicar o BR-2 e gravar no `map.log` o que mudou (documentos, nós e aspectos). (BR-2)
- FR-2: o `kb-publish` deve chamar o `update` depois do `link` e antes do `index` e do sync. Uma falha do update marca o documento como pendente, sem falhar o job. (BR-1, BR-3)
- FR-3: o catálogo da API deve ler o estado do mapa de cada documento (`mapped`, `pending`) e expô-lo à Pesquisa com IA. (BR-1)
- FR-4: `kb-map add` deve rodar a sequência inteira para um texto e parar no primeiro erro, dizendo em que passo parou. (BR-1)

## Non-functional requirements
- NFR-1: inserir um documento de 50 KB atualiza o mapa em ≤ 10 min na assinatura, com no máximo 5 dossiês refeitos em média.

## Acceptance criteria
- AC-1 (FR-1, BR-2): Given o mapa pronto e um documento novo sobre o ritmo, When `kb-map update` roda, Then o dossiê Ritmo ganha as seções novas, e os dossiês sem seção nova ficam iguais byte a byte.
- AC-2 (FR-2): Given uma faixa publicada que fala de polaridade, When o job `kb-publish` termina, Then a faixa está no dossiê Polaridade e o check passa.
- AC-3 (BR-3, negativo): Given o provedor fora do ar, When o job roda, Then a faixa chega à produção como "pendente no mapa" e o próximo job a mapeia.
- AC-4 (BR-4): Given um documento apagado, When o sync roda, Then nenhum dossiê o cita mais.
- AC-6 (BR-5): Given uma faixa e um texto que tratam do mesmo aspecto da polaridade, When os dois entram, Then os dois aparecem no mesmo aspecto do dossiê, do mesmo jeito; a seção da faixa começa e termina numa âncora de tempo.
- AC-7 (BR-5): Given a transcrição de uma faixa corrigida, When o job `kb-publish` roda, Then as seções da faixa são refeitas e o dossiê tocado é atualizado.
- AC-5 (FR-4): Given um PDF novo, When `kb-map add hermetismo livro.pdf` roda, Then ele está no catálogo, no mapa e na produção.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1, AC-3, AC-4 | unitário (pytest) | Provedor fake |
| AC-2, AC-6, AC-7 | integração (transcritor) | Job `kb-publish` de fixture |
| AC-5 | manual (registrado) | Mac do dono, staging |
| FR-3 | integração (API) | Catálogo com mapa de fixture |

## References
`docs/research/2026-11-16-complete-answers-deep.md` §4 · ADR 0035 (kb-publish) · `tools/transcriber/src/transcriber/kb_publish.py` · `deploy/scripts/sync-vault.sh`

## Decisões assumidas (o dono pode mudar)
- Uma falha do mapa não segura a entrada do documento: ele entra pendente, e o Profundo o procura pela busca até ser mapeado.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
