---
id: KBC-113
title: "Sugestões para a lista de termos a partir das correções: o master aceita ou dispensa"
status: ready
slice: phase-2-editing
outcome: os nomes e termos que as pessoas corrigem à mão chegam à lista de termos do transcritor com um clique de um master, e as próximas transcrições erram menos; meta ≥ 50 % das sugestões com 3 ou mais correções decididas (aceitas ou dispensadas) em 30 dias
depends_on: [KBC-093, KBC-040]
---

# KBC-113 — Sugestões para a lista de termos a partir das correções

Decisão do dono de 2026-11-07 (conversa), sobre a pergunta 5 do KBC-093: "Não, mas ela deve ficar como uma sugestão para entrar na lista de termos". A palavra corrigida não entra sozinha na lista (KBC-093 BR-16); vira sugestão, e um master decide. Item separado do KBC-093 por decisão do planejamento: a sugestão aparece na tela da lista de termos (T21, KBC-040), que é só de masters, e não na tela de preparo.

## Story
Como master que cuida da lista de termos do transcritor, quero ver os termos que as pessoas corrigiram à mão, com quantas correções cada um teve, para pôr na lista os que valem e a próxima transcrição já acertar.

## Scope
**In:** bloco **Sugestões das correções** na T21 (Configurações → Termos da transcrição): termo sugerido, quantas correções o produziram, exemplos "antes → depois" com a gravação e o tempo, **Adicionar à lista** e **Dispensar**; lista **Dispensadas** fechada por padrão, com **Restaurar**; contagem de sugestões novas no título do bloco.
**Out:** pôr o termo na lista sem um master (decisão do dono); transcrever de novo o que já foi transcrito (continua "Transcrever de novo", KBC-040); sugerir a partir de outra fonte que não as correções; mudar a regra do limite de 224 tokens.

## Business rules
- BR-1: uma sugestão nasce do texto novo das correções **em vigor** do KBC-093 (não desfeitas e reaplicadas ou ainda na versão atual; não as "não reaplicadas"), sem a pontuação das pontas e sem espaços sobrando. Texto vazio (palavra apagada) nunca é sugestão.
- BR-2: correções com o mesmo texto sem diferença de maiúsculas formam **uma** sugestão; o termo mostrado é a forma mais usada (empate: a mais recente). A contagem é o número de correções (cada ocorrência de um "Corrigir todas" conta uma) e também o número de gravações ("7 correções em 3 gravações").
- BR-3: um termo que já está na lista atual (sem diferença de maiúsculas) não é sugerido.
- BR-4: só masters veem, aceitam, dispensam e restauram sugestões (a T21 já é só de masters). A sugestão mostra gravações de qualquer acervo, porque masters veem tudo.
- BR-5: **Adicionar à lista** põe o termo na lista em edição da T21, como se o master o tivesse digitado; nada é salvo antes de **Salvar lista**, que cria a versão nova com data e autor (KBC-040 BR-1). As regras do KBC-040 valem: repetido fica de fora, o limite de 224 tokens é conferido pelo servidor, e o conflito com outra pessoa mantém a edição com **Recarregar**. Depois de salvar, a sugestão some (BR-3).
- BR-6: **Dispensar** grava na hora, com quem e quando; a sugestão vai para **Dispensadas** e não volta sozinha, mesmo com correções novas (a contagem continua subindo lá). **Restaurar** a traz de volta às sugestões.
- BR-7: desfazer correções pode zerar uma sugestão: com 0 correções em vigor, ela some (da lista e das dispensadas).
- BR-8: nada desta tela muda uma transcrição já feita nem o histórico de correções.

## Functional requirements
- FR-1: `GET /api/v1/media/terms/suggestions` (só masters) deve devolver as sugestões (termo, chave sem maiúsculas, correções, gravações, até 3 exemplos com gravação, tempo, "antes → depois", data da última) e as dispensadas, calculadas das correções em vigor no `media.db`. (BR-1 a BR-4, BR-7)
- FR-2: `POST /api/v1/media/terms/suggestions/{key}/dismiss` e `…/restore` (só masters) devem gravar e apagar a dispensa (tabela nova com chave, autor e data, migração só aditiva). (BR-6)
- FR-3: a T21 deve mostrar o bloco **Sugestões das correções (4 novas)** entre "Adicionar termos" e a lista: uma linha por sugestão com "Tiuaco · 7 correções em 3 gravações", os exemplos (com **Ouvir** e link para a gravação no tempo), **Adicionar à lista** e **Dispensar**; mais recentes primeiro. (BR-2, BR-5, BR-6)
- FR-4: **Adicionar à lista** deve pôr o termo na lista em edição, marcar a linha "Na lista (falta salvar)" e mostrar **Descartar mudanças**, como uma edição à mão. (BR-5)
- FR-5: o servidor deve recusar a lista salva acima do limite como no KBC-040, com a mensagem "A lista passou do limite do transcritor (231 de 224). Remova alguns termos." (BR-5)

## Non-functional requirements
- NFR-1: `GET …/suggestions` p95 ≤ 200 ms com 10.000 correções em 500 gravações (integração com dados sintéticos).
- NFR-2: WCAG 2.2 AA: botões com nome que inclui o termo ("Adicionar Tiuaco à lista"), resultado anunciado por região viva educada, alvos ≥ 44×44 px no celular, 390 px sem rolagem lateral, axe sem violações sérias nos três temas.

## Acceptance criteria
- **AC-1** (BR-1, BR-2, FR-1, FR-3): Given 5 correções "Tiuako" → "Tiuaco" em 2 gravações e 2 "tiuako" → "tiuaco," em outra, When um master abre Termos da transcrição, Then vê "Tiuaco · 7 correções em 3 gravações" com até 3 exemplos.
- **AC-2** (BR-1, negativo): Given só palavras apagadas e correções desfeitas, Then nenhuma sugestão aparece e o bloco diz "Nenhuma sugestão das correções por enquanto."
- **AC-3** (BR-3): Given "Tiuaco" já na lista, Then não é sugerido.
- **AC-4** (BR-5, FR-4): Given a sugestão "Tiuaco", When o master usa Adicionar à lista, Then o termo aparece na lista em edição, a linha diz "Na lista (falta salvar)" e nenhuma versão nova existe; When usa Salvar lista, Then a versão nova tem "Tiuaco", com data e autor, e a sugestão some.
- **AC-5** (BR-5, limite): Given a lista com 222 de 224 tokens, When o master adiciona uma sugestão que passaria do limite e salva, Then o servidor recusa com "A lista passou do limite do transcritor (… de 224). Remova alguns termos." e a edição fica na tela.
- **AC-6** (BR-5, conflito): Given outro master salvou a lista depois de a tela abrir, When este salva com a sugestão, Then a edição fica e aparece Recarregar (KBC-040).
- **AC-7** (BR-6, FR-2): Given a sugestão "Mareri", When o master usa Dispensar, Then ela vai para Dispensadas na hora; com 3 correções novas de "Mareri", continua lá com a contagem nova; Restaurar a traz de volta.
- **AC-8** (BR-7): Given a sugestão "Tiuaco" de um só grupo de 12 correções, When o grupo é desfeito, Then a sugestão some.
- **AC-9** (BR-4, permissão): Given um membro (mesmo com `media-correct`), Then a API responde 403 a `…/suggestions`, `…/dismiss` e `…/restore`, e a tela não existe para ele.
- **AC-10** (BR-8): Given uma sugestão aceita e salva, Then nenhuma transcrição já feita muda e o histórico de correções fica igual; a próxima transcrição usa a versão nova da lista (KBC-040 FR-1).
- **AC-11** (NFR-2): Given só o teclado e 390 px, Then Tab chega a Adicionar e Dispensar de cada linha, o leitor de tela ouve "Adicionar Tiuaco à lista" e "Tiuaco dispensado", e a tela não rola para o lado.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-3, AC-7, AC-8, AC-9 | integração API | `term-suggestions.integration.test.ts` com correções semeadas pelo serviço do KBC-093 |
| AC-1, AC-2 | unitário | agrupamento e forma mais usada (`term-suggestions.test.ts`) |
| AC-4, AC-5, AC-6, AC-10 | integração API + componente (web) | lista de termos do KBC-040, versão, limite e conflito; `term-suggestions.spec.ts` |
| AC-4, AC-7, AC-11 | E2E | `e2e/specs/media-terms.spec.ts` estendido, 1440 e 390 px, axe nos três temas |
| NFR-1 | integração com medição | 10.000 correções sintéticas |

## References
Tela: T21 em `docs/design/screens.md` (emenda de 2026-11-07) · ADR: [0034](../adr/0034-transcript-word-corrections.md) (o histórico de correções; "Revisit when" da lista de termos), [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) · Itens: KBC-093 (BR-8, BR-16), KBC-040 (BR-1, BR-2, FR-1, FR-2).

## Open questions
Nenhuma. Decisão do dono de 2026-11-07: a palavra corrigida vira sugestão para a lista de termos, sem entrar sozinha. Premissas do planejamento (o dono pode mudar): sugestão a partir de 1 correção; dispensada não volta sozinha (BR-6).

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] Tela e ADR ligadas
- [x] Dependências agendadas (KBC-093 antes; KBC-040 no `develop`)
- [x] Cabe num goal
