---
id: KBC-069
title: "Classificar faixas por assunto: ligar cada faixa aos conceitos do acervo e a assuntos livres, com sugestão da IA e confirmação de uma pessoa"
status: ready
slice: phase-2-editing
outcome: toda faixa publicada fica ligada a 1 a 5 assuntos do acervo, com ≥ 80 % das sugestões da IA aceitas sem mudança, para a busca e os filtros a acharem pelo assunto
depends_on: [KBC-068, KBC-067]
---

# KBC-069 — Classificar faixas por assunto

## Story
Como quem edita, quero que cada faixa passe pela mesma classificação do acervo (os conceitos que o `kb` já usa nos documentos) e ganhe links para os assuntos relacionados, para que quem pesquisa ache a pergunta e a resposta pelo assunto.

## Scope
**In:** permissão nova `media-classify` ("Classificar mídia por assunto"); na tela "Editar em faixas", coluna "Assuntos" por faixa: escolher conceitos do acervo (lidos do catálogo do vault, só leitura, KBC-002/KBC-003) e assuntos livres do acervo (lista nova em `media.db`); "Sugerir assuntos com IA" para quem também tem `media-edit-ai` (uma chamada por edição, todas as faixas juntas, mesmo livro e teto do KBC-067); um resumo de 1 a 2 frases por faixa, sugerido junto e editável; as ligações guardadas em `media.db` (ADR 0029), nunca no vault (Q7); a página da faixa mostra os assuntos para quem edita (para quem ouve, no KBC-070).
**Out:** criar conceito novo no vault (só o `kb` no Mac do dono cria); relevância e profundidade do `kb classify` para mídia; classificar documentos; filtros e busca por assunto (KBC-070).

## Business rules
- BR-1: uma faixa tem de 0 a 5 assuntos; cada assunto é um conceito do acervo (por nome, como o catálogo resolve) ou um assunto livre do acervo; um sub-acervo usa os conceitos e os assuntos do acervo pai.
- BR-2: a IA só sugere entre os conceitos e os assuntos livres que já existem; um assunto novo sugerido aparece como "Novo assunto: «nome»" e só é criado se a pessoa aceitar.
- BR-3: sugestões não aceitas não valem para a busca; aceitar ou recusar exige `media-classify`.
- BR-4: se um conceito some do vault depois de uma sincronização, a ligação continua guardada e aparece como "Assunto não encontrado no acervo" a quem edita, sem quebrar a faixa.
- BR-5: o gasto da sugestão segue o KBC-067 BR-3 (livro mensal da mídia e teto por análise).

## Functional requirements
- FR-1: `GET /api/v1/topics/{slug}/subjects` deve devolver os conceitos do catálogo e os assuntos livres do acervo; `POST` cria um assunto livre (1 a 80 caracteres, sem repetir sem acento e sem maiúscula). (BR-1, BR-2)
- FR-2: `PUT /api/v1/media/{id}/subjects` deve gravar os assuntos e o resumo de uma faixa. (BR-1, BR-3)
- FR-3: `POST /api/v1/media/{id}/edit/subject-proposals` deve estimar e rodar a sugestão para todas as faixas da edição publicada, com saída validada por esquema e só com assuntos existentes ou marcados "novo". (BR-2, BR-5)
- FR-4: A tela deve mostrar as sugestões como chips "Sugerido" com "Aceitar" e "Recusar" por chip e "Aceitar todas as sugestões desta faixa".
- FR-5: O catálogo relido depois de uma sincronização deve marcar as ligações a conceitos sumidos. (BR-4)

## Non-functional requirements
- NFR-1: ≥ 80 % das sugestões aceitas sem mudança nas faixas das 2 gravações de teste do KBC-063, com o gabarito de assuntos do dono.
- NFR-2: custo ≤ US$ 0,02 por hora de áudio, medido no livro da mídia.

## Acceptance criteria
- **AC-1** (FR-3, FR-4, BR-2): Given 12 faixas publicadas no acervo "Hermetismo" e o provedor stub, When quem edita pede "Sugerir assuntos com IA", Then cada faixa recebe de 1 a 5 chips "Sugerido", todos conceitos do acervo ou "Novo assunto: …".
- **AC-2** (BR-3, FR-2): Given sugestões não aceitas, When a faixa é consultada pela API de busca do KBC-070, Then elas não contam; When quem edita aceita, Then passam a contar.
- **AC-3** (BR-1, limite): Given uma faixa com 5 assuntos, When quem edita tenta pôr o sexto, Then a tela recusa com "Até 5 assuntos por faixa".
- **AC-4** (FR-1, negativo): Given o assunto livre "Burracheira", When alguém cria "burracheira", Then é recusado como repetido.
- **AC-5** (BR-4, FR-5): Given uma faixa ligada ao conceito "Cabala" e o conceito removido do vault, When o catálogo é relido, Then a faixa mostra "Assunto não encontrado no acervo" a quem edita e continua tocando.
- **AC-6** (permissão): Given quem tem `media-edit` sem `media-classify`, When abre a edição, Then não vê a coluna "Assuntos" e `PUT …/subjects` responde 403; Given `media-classify` sem `media-edit-ai`, Then não vê "Sugerir assuntos com IA".
- **AC-7** (BR-5): Given o teto mensal da mídia atingido, When quem edita pede a sugestão, Then ela não roda e a tela diz por quê.
- **AC-8** (Q7): Given qualquer ação deste item, When o teste confere o vault de fixture, Then nenhum arquivo do vault mudou.
- **AC-9** (acessibilidade): chips com nome acessível ("Aceitar sugestão Cabala"), sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-7 | integração com LLM stub | |
| AC-2, AC-3, AC-4, AC-6 | integração + componente | |
| AC-5 | integração com o catálogo de fixture | |
| AC-8 | integração (hash do vault antes e depois) | |
| AC-9 | E2E | axe |
| NFR-1, NFR-2 | manual na validação local | gabarito do KBC-063 |

## References
ADR [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md), 0003 (facetas do catálogo), 0024 · Catálogo: `apps/api/src/modules/catalog/relations.ts` (conceitos) · Tela T20

## Decisão do dono (2026-11-03)
- **Teto e fonte da IA** — o mesmo padrão aprovado no KBC-067 (modelo barato e pago pela IA da aplicação, no limite mensal da mídia de US$ 10, teto de US$ 0,25 por análise, estimativa antes; modelo local no Mac como padrão se a pesquisa achar um bom o bastante).

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled; no open questions
- [x] Fits one goal
