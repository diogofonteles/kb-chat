---
id: KBC-141
title: "Mapa do acervo (3): dossiê por assunto com todos os trechos, e a checagem de completude por código"
status: ready
slice: complete-answers
outcome: cada assunto tem o seu "mapa mental" (aspectos, todos os trechos, concordâncias e divergências), e um teste prova que nenhum trecho do assunto ficou de fora
depends_on: [KBC-140]
---

# KBC-141 — Dossiê por assunto e `kb-map check`

## Story
Como estudante, quando pergunto sobre um assunto, quero que a resposta parta de tudo o que o acervo diz sobre ele, organizado por aspecto, para não depender do que a busca acertou na hora.

## Scope
**In:**
- um dossiê por nó em `<topic>/map/dossiers/<node>.json`, mais a página de conceito do kb preenchida com a versão legível;
- o conteúdo do dossiê:
  - os aspectos do assunto;
  - para cada aspecto, todas as seções que o tratam, com as centrais marcadas;
  - o autor de cada seção;
  - onde os autores concordam e onde divergem;
- o `kb-map check`, que roda antes de todo sync.

**Out:** usar o dossiê na resposta (KBC-144); a atualização ao inserir (KBC-142).

## Business rules
- BR-1: o dossiê de um nó cita **exatamente** o conjunto das suas seções: nem uma a menos, nem uma a mais. Toda seção está em pelo menos um aspecto.
- BR-2: o texto do dossiê só afirma o que as seções dizem; cada frase cita a sua seção (como a ADR 0004 pede às respostas).
- BR-3: o ensinamento do Mestre Laércio é separado do de outros autores (ADR 0015).
- BR-4: `kb-map check` falha se uma seção `ok` não estiver em nenhum nó, se um dossiê não bater com o seu nó (BR-1) ou se um documento tiver o mapa de outro conteúdo (hash).

## Functional requirements
- FR-1: `kb-map dossier <topic> [--node <id>]` deve gerar os dossiês, conferir o BR-1 e repetir os aspectos que faltarem antes de gravar. (BR-1, BR-2, BR-3)
- FR-2: `kb-map check <topic>` deve sair com código ≠ 0 e listar cada problema quando o BR-4 não for atendido. (BR-4)
- FR-3: `deploy/scripts/sync-vault.sh` deve rodar `kb-map check` dos acervos com mapa e não mandar o mapa novo quando falhar. O resto do vault segue. (BR-4)

## Non-functional requirements
- NFR-1: `kb-map check` do Hermetismo inteiro roda em ≤ 30 s, sem chamar modelo.

## Acceptance criteria
- AC-1 (FR-1, BR-1): Given o nó Ritmo com 12 seções, When o dossiê é gerado, Then os aspectos citam as 12, cada uma pelo menos uma vez.
- AC-2 (FR-1, negativo): Given um modelo que esquece 2 seções, When o dossiê é conferido, Then o aspecto é refeito com as 2 antes de gravar.
- AC-3 (BR-3): Given seções do Mestre Laércio e de outro autor sobre o mesmo aspecto, When o dossiê é gerado, Then as duas visões aparecem separadas e nomeadas.
- AC-4 (FR-2, BR-4): Given uma seção nova sem nó, When `kb-map check` roda, Then sai com erro e nomeia a seção.
- AC-5 (FR-3): Given o check falhando, When o sync roda, Then o mapa da produção continua o anterior e o log diz por quê.

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1–AC-4 | unitário (pytest) | Provedor fake |
| AC-5 | integração (shell) | `sync-vault.sh --dry-run` com fixture |
| NFR-1 | medição | Vault real |

## References
`docs/research/2026-11-16-complete-answers-deep.md` §3 e §4 · ADR 0004, 0015 · KBC-137 (a Página do assunto usa o dossiê)

## Decisões assumidas (o dono pode mudar)
- A versão legível do dossiê entra na página de conceito do kb, que hoje é um stub.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done or scheduled; decisions assumed are listed (the owner can change them)
- [x] Fits one goal
