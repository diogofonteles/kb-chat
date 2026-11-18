---
id: KBC-156
title: "Trecho citado com a frase inteira, nunca um pedaço de 1 s"
status: ready
slice: complete-answers
outcome: todo trecho de faixa citado por uma resposta cobre a(s) frase(s) inteira(s) em volta do tempo citado, com contexto mínimo (≥ 8 s ou ≥ 12 palavras) e no máximo 45 s
depends_on: [KBC-099, KBC-150]
---

# KBC-156 — Trecho citado com a frase inteira

Pedido do dono (2026-11-17): na Pesquisa com IA, a resposta "Alfredo Gabriel… conta várias lembranças da infância" citou [8] "Namoros e gostos de Mestre Gabriel · 0:00", e o trecho aberto foi "É, italiano, tá." (0:00–0:01): um segundo que não apoia a afirmação. Decisão ("Trecho com a frase inteira"): a pesquisa nunca cita um pedaço de 1 s; o trecho cobre a frase que apoia a afirmação, com contexto mínimo.

Causa: o trecho de uma citação `[n@m:ss]` é exatamente **um** segmento de media.db (`snapToSegment`, ADR 0035 §6). A âncora `[m:ss]` do documento da faixa só localiza o segmento; o tamanho do segmento é o que a transcrição deu, e uma fala curta ("É, italiano, tá.") é um segmento de 1 s.

## Story
Como estudante que abre a fonte de áudio de uma resposta, quero ouvir e ler a frase inteira que sustenta a afirmação, para conferir a resposta sem caçar o contexto na faixa.

## Scope
**In:** a regra do trecho citado na API (respostas novas) e no painel "Fonte de áudio" (respostas já salvas, com a transcrição que a pessoa pode ouvir); a instrução do modelo de citar a âncora onde começa a frase que sustenta a afirmação.
**Out:** verificação do conteúdo da citação (KBC-145); trechos da busca ("Na fala"); o tempo escrito na pílula da resposta; redesenho do agente.

## Business rules
- BR-1: o trecho citado contém o tempo citado e cobre frases inteiras: começa onde começa a frase do segmento citado e termina onde ela termina (fim de frase: `.` `!` `?` `…`). Transcrição sem nenhuma pontuação de fim de frase: cada segmento conta como uma frase.
- BR-2: contexto mínimo: enquanto o trecho tiver menos de 8 s e menos de 12 palavras, entra a frase seguinte inteira; sem ela, a anterior inteira. O contexto é fala contígua: não atravessa um silêncio de mais de 3 s.
- BR-3: máximo de 45 s: nada entra se passar disso (o segmento citado sozinho fica inteiro, mesmo maior).
- BR-4: o trecho nunca atravessa uma troca de voz (quando a transcrição diz quem fala) nem uma parte que a pessoa não pode ouvir (KBC-106 BR-2); o texto dessa parte nunca aparece.
- BR-5: respostas já salvas, com o trecho antigo, mostram o trecho alargado pela mesma regra ao abrir a fonte; os tempos escritos na resposta não mudam.

## Functional requirements
- FR-1: ao fim do turno, cada `[n@m:ss]` e `[n]` de faixa vira um trecho alargado por BR-1..BR-4 sobre os segmentos de media.db (API). (BR-1..BR-4)
- FR-2: o painel "Fonte de áudio" alarga o trecho salvo com a transcrição que a pessoa recebe (com vozes e partes restritas) e mostra "Citado na resposta · início–fim" e a linha citada com as frases inteiras. (BR-4, BR-5)
- FR-3: a instrução de citação diz ao modelo para citar a âncora do parágrafo onde começa a frase que sustenta a afirmação. (BR-1)

## Acceptance criteria
- AC-1 (FR-1, BR-1, BR-2): Given o segmento citado "É, italiano, tá." (0:00–0:01) seguido de frases sem pausa, When a resposta cita `[1@0:00]`, Then o trecho vai de 0:00 ao fim da frase seguinte (≥ 8 s ou ≥ 12 palavras), não 0:00–0:01.
- AC-2 (BR-1): Given um segmento que termina com vírgula, Then o trecho segue até o segmento que fecha a frase; Given o segmento citado no meio de uma frase, Then o trecho começa no segmento que abre a frase.
- AC-3 (BR-3, edge): Given um monólogo sem pontuação de fim por 2 min, Then o trecho tem no máximo 45 s e contém o tempo citado.
- AC-4 (BR-4, negative): Given a frase seguinte de outra voz, Then ela não entra; Given um vizinho restrito para a pessoa, Then o trecho não o inclui nem mostra seu texto.
- AC-5 (BR-2, edge): Given o tempo citado no começo da faixa, Then o contexto vem depois; Given no fim da faixa, Then vem antes; Given só silêncio (> 3 s) em volta, Then o trecho é o segmento sozinho.
- AC-6 (BR-1, edge): Given uma transcrição sem pontuação, Then cada segmento é uma frase e o contexto mínimo vale do mesmo jeito.
- AC-7 (FR-2, BR-5): Given uma resposta salva com o trecho 0:00–0:01, When abro a fonte de áudio em 1440 e em 390, Then "Citado na resposta" mostra 0:00 até o fim da frase seguinte e a linha citada tem as duas frases.
- AC-8 (FR-3): o texto do sistema da pesquisa pede a âncora do parágrafo onde começa a frase que sustenta a afirmação.

## Test strategy
- AC-1..AC-6: unidade de `wholeSentences` (`libs/contracts/src/track-citations.test.ts`) e de `resolvePassages` (API).
- AC-4 (restrito) e AC-7: spec do painel (`track-passage-panel.spec.ts`) e E2E `media-audio-source` em 1440 e 390.
- AC-8: teste do prompt.

## Definition of ready
Pedido e decisão do dono registrados; regra com números; arquivos conhecidos (contracts, `passage-resolution.ts`, `track-shelf.ts`, painel); sem migração nem contrato novo.
