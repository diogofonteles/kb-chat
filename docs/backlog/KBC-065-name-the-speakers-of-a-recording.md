---
id: KBC-065
title: "Dar nome às vozes de uma gravação: falantes por acervo, \"Pergunta da plateia\" e quem fala na transcrição"
status: ready
slice: phase-2-editing
outcome: quem estuda lê na transcrição quem está falando (por exemplo, "Mestre Gabriel" respondendo), e quem edita nomeia as vozes de uma palestra em menos de 1 minuto
depends_on: [KBC-064, KBC-049]
---

# KBC-065 — Dar nome às vozes de uma gravação

## Story
Como quem edita, quero dizer que a "Voz 1" é o Mestre e a "Voz 2" é uma pergunta da plateia, para que todos que ouvem saibam quem está falando em cada trecho.

## Scope
**In:** lista de falantes por acervo ("Falantes": nome e, se for o caso, o autor do KBC-049 que ele é); na página do áudio, painel "Vozes" para quem tem `media-edit`: cada voz com amostra de 5 s para ouvir, tempo de fala e um campo para escolher o falante (combobox com os falantes do acervo, os autores do acervo, "Pergunta da plateia" e "Cadastrar «nome»"); juntar duas vozes que são a mesma pessoa; permissão nova `media-speakers` ("Ver quem fala na transcrição") para quem ouve; a transcrição ao lado e a legenda mostram o nome do falante na troca.
**Out:** sugerir o nome sozinho (pelo contexto: KBC-067; pela voz: KBC-071); falantes globais entre acervos; editar o texto da transcrição.

## Business rules
- BR-1: cada acervo tem sua lista de falantes; um sub-acervo usa a do acervo pai (como os autores, KBC-049).
- BR-2: um falante pode ser ligado a um autor do acervo; ligado, mostra o nome do autor e, se for o autor principal, o ✦.
- BR-3: "Pergunta da plateia" é um falante especial de todo acervo, sem nome de pessoa; quem pergunta da plateia não é nomeado por padrão (decisão assumida abaixo).
- BR-4: nomear ou juntar vozes exige `media-edit` no acervo do áudio; ver os nomes exige `media-speakers` e acesso ao áudio.
- BR-5: os nomes valem para a versão da separação de vozes; uma separação nova pede que os nomes sejam confirmados de novo, já pré-preenchidos pela sobreposição de tempo (≥ 70 % do tempo da voz antiga dentro da nova).
- BR-6: voz sem nome aparece como "Voz N" para quem edita e como "Falante não identificado" para quem só ouve.

## Functional requirements
- FR-1: `GET/POST /api/v1/topics/{slug}/speakers` deve listar e cadastrar falantes (nome 1 a 120 caracteres, autor opcional); `PATCH` renomeia. (BR-1, BR-2, BR-4)
- FR-2: `PUT /api/v1/media/{id}/voices/{voice}` deve ligar uma voz a um falante ou a "Pergunta da plateia"; `POST /api/v1/media/{id}/voices/merge` junta duas vozes. (BR-4, BR-5)
- FR-3: O painel "Vozes" deve tocar uma amostra de 5 s do trecho mais longo de cada voz e mostrar o tempo total de fala.
- FR-4: Para quem tem `media-speakers`, a transcrição ao lado deve mostrar o nome do falante na troca de falante, e a legenda deve prefixar o cue com o nome quando o falante muda ("— Mestre Gabriel: …"), lembrando a escolha "Mostrar quem fala" (ligada por padrão). (BR-6)
- FR-5: Uma separação nova deve pré-preencher os nomes pela sobreposição e mostrar "Confirme os nomes das vozes" até alguém confirmar. (BR-5)

## Non-functional requirements
- NFR-1: salvar um nome responde em ≤ 300 ms e a transcrição aberta por outra pessoa mostra o nome na próxima abertura, medido no teste de integração.
- NFR-2: as sugestões do combobox aparecem em ≤ 100 ms com 500 falantes no acervo.

## Acceptance criteria
- **AC-1** (FR-2, FR-4): Given uma palestra com 3 vozes no acervo "UDV", When quem edita liga a Voz 1 a "Mestre Gabriel" (autor principal) e as Vozes 2 e 3 a "Pergunta da plateia", Then quem ouve com `media-speakers` vê "✦ Mestre Gabriel" e "Pergunta da plateia" na transcrição e na legenda.
- **AC-2** (FR-1, BR-1): Given "Palavra do Mestre" dentro da UDV, When quem edita abre o combobox, Then vê os falantes e autores da UDV.
- **AC-3** (FR-2, merge): Given a Voz 2 e a Voz 4 que são a mesma pessoa, When quem edita junta as duas, Then a transcrição mostra um só falante nos trechos de ambas.
- **AC-4** (BR-4, permissão): Given uma pessoa com `media` e sem `media-speakers`, When abre o áudio, Then a transcrição aparece como antes, sem nomes; e sem `media-edit`, `PUT …/voices/1` responde 403.
- **AC-5** (BR-6): Given uma voz sem nome, When quem só ouve abre a transcrição, Then lê "Falante não identificado".
- **AC-6** (BR-5, FR-5): Given nomes dados e uma separação refeita, When ela termina, Then os nomes vêm pré-preenchidos e o aviso "Confirme os nomes das vozes" aparece para quem edita até a confirmação.
- **AC-7** (FR-1, negativo): Given um nome vazio ou com 121 caracteres, When quem edita cadastra, Then o campo mostra o erro e nada é criado.
- **AC-8** (FR-3, acessibilidade): o painel "Vozes" funciona só com teclado (amostra com botão "Ouvir amostra da Voz N"), sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-3 | integração + E2E | fixture de turnos com 4 vozes |
| AC-2, AC-7 | integração | |
| AC-4 | integração + E2E | três contas (master, editor, ouvinte) |
| AC-5, AC-6 | integração | |
| AC-8 | E2E | axe |

## References
ADR [0029 (proposta)](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) · KBC-049 (autores por acervo) · Tela T15 (painel "Vozes" a desenhar com o `product-designer` na spec) · Pesquisa: KBC-063

## Decisões assumidas (o dono pode mudar)
- Quem pergunta da plateia fica como "Pergunta da plateia", sem nome, porque é pessoa privada que não consentiu em ser identificada; o editor pode cadastrar o nome se a pessoa autorizou.
- Os falantes ficam por acervo, como os autores.

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
