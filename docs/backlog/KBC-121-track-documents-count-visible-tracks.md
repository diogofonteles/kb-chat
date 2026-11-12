---
id: KBC-121
title: "Documento de faixa sem a contagem de todas as faixas: o texto que o Mac grava no vault deixa de dizer \"faixa n de N\" sobre faixas acima do nível de quem lê"
status: draft
slice: levels-release-2
outcome: nenhum documento de faixa no vault diz quantas faixas a gravação tem além das que quem o lê ouve; a API e o texto contam igual
depends_on: [KBC-111, KBC-099, KBC-100, KBC-106]
parent: LEVELS
---

# KBC-121 — Documento de faixa sem a contagem de todas as faixas

*Aberto pelo KBC-111 (revisão, rodada 2), 2026-11-12.* Desde o KBC-111 a API conta "faixa n de N" sobre as faixas que a pessoa ouve (decisão do dono de 2026-11-12) em todo lugar que monta: item de mídia, biblioteca, lista de faixas, cartão de faixa da busca, "Veja também", fontes da pesquisa e o que o modelo recebe (`LevelView.trackPlace`). Fica de fora só o texto que o Mac grava no próprio documento de faixa (ADR 0035, `apps/api/src/modules/media-documents/track-document.ts`, `recordingLine` e as chaves `kb_chat_track_ordinal`/`kb_chat_tracks_total`): a linha "Gravação: X · faixa n de N" conta todas as faixas, e chega a quem lê o documento como texto (um trecho, uma leitura pela IA). O vault é um só para todos, então o texto não pode ser contado por pessoa.

## Story
Como dono, quero que o texto de um documento de faixa não diga quantas faixas a gravação tem, para que quem ouve só parte dela não saiba que há faixas acima do seu nível.

## Scope
**In:** um novo modelo de documento de faixa (emenda da ADR 0035) sem o total na linha de cabeçalho e sem `kb_chat_tracks_total` (o número da faixa, se ficar, também conta as ocultas: decidir), com a versão do modelo no fingerprint, e a republicação de todos os documentos de faixa pelo Mac (`kb classify`, `kb link`, `kb index`), medida em custo e tempo antes de rodar na produção.
**Out:** a contagem da API (feita no KBC-111); o leiaute do player.

## Business rules
- BR-1: nenhum documento de faixa no vault conta faixas que não sejam a dele.
- BR-2: a API continua montando "faixa n de N" sobre as faixas que a pessoa ouve (KBC-111).
- BR-3: a republicação é retomável e não paga duas vezes o mesmo documento (ADR 0035, KBC-100).

## Functional requirements
- FR-1: `track-document.ts` sem o total (e sem o número, se for o caso) no texto e no cabeçalho, com a versão do modelo no fingerprint. (BR-1)
- FR-2: os documentos já publicados entram na fila de republicação pela troca da versão, em lotes, com o gasto do mês respeitado. (BR-3)
- FR-3: a suíte de vazamento deixa de declarar `RAW_TRACK_HEADER` em `levels-leakage.integration.test.ts`. (BR-1)

## Non-functional requirements
- NFR-1: a republicação dos documentos de faixa da produção cabe no teto mensal de mídia; o custo e o tempo estimados aparecem antes de começar.

## Acceptance criteria
- **AC-1** (BR-1): Given uma gravação com uma faixa CDC e Ana em CI, When ela lê o documento de outra faixa pela IA ou pela busca, Then o texto não diz quantas faixas a gravação tem.
- **AC-2** (FR-3): Given a suíte de vazamento sem `RAW_TRACK_HEADER`, Then o gêmeo continua igual.
- **AC-3** (BR-3): Given uma republicação interrompida, When ela volta, Then só os documentos que faltam são pagos.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2 | integração | `levels-leakage.integration.test.ts` com os documentos de faixa do mundo |
| AC-3 | integração | fila de publicação do KBC-100 |

## Open questions
- Q-1 (dono): o número da faixa ("faixa 2") fica no texto? Ele também denuncia uma faixa oculta antes dela.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC
- [x] NFR medido
- [ ] Q-1 respondida
