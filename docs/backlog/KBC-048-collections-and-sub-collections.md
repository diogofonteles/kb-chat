---
id: KBC-048
title: "Acervos e sub-acervos pela tela: criar, renomear e organizar acervos dentro de acervos"
status: ready
slice: phase-2-a
outcome: quem tem permissão cria um acervo novo (ou um sub-acervo dentro de outro) pela tela, em menos de 1 minuto, sem terminal e sem reiniciar o servidor
depends_on: [KBC-034]
---

# KBC-048 — Acervos e sub-acervos pela tela

## Story
Como quem envia conteúdo, quero criar um acervo (por exemplo, "UDV") e sub-acervos dentro dele (por exemplo, "Palavra do Mestre"), para organizar o material por tradição e por tema sem pedir a ninguém para mexer no servidor.

## Scope
**In:** permissão nova "Criar acervos"; criar acervo e sub-acervo (nome e descrição curta); renomear; o seletor "Acervo" da lateral mostra a árvore (acervo com seus sub-acervos, recuados); acesso por pessoa a um acervo inteiro ou a um sub-acervo só; o acervo novo aparece para quem criou na hora, sem reiniciar a API.
**Out:** apagar acervo com conteúdo (fica para depois, com confirmação forte); mover documentos entre acervos; mais de um nível de sub-acervo; grupos (KBC-047).

## Business rules
- BR-1: regra do dono (2026-10-28): "Criar acervos" é liberada por pessoa (ou grupo, KBC-047); nenhuma pessoa a tem sem que um master libere. O dono pediu em 2026-10-29 que ela possa ser dada a quem tem permissão de enviar conteúdo.
- BR-2: um acervo tem no máximo um nível de sub-acervos (acervo → sub-acervo), o mesmo limite de leitura do vault hoje.
- BR-3: quem pode ver um acervo vê todos os seus sub-acervos; dar acesso só a um sub-acervo não mostra o conteúdo próprio do acervo pai (o pai aparece só como título do grupo).
- BR-4: o identificador do acervo (pasta no vault e endereço) sai do nome, sem acento, em minúsculas, único; renomear muda só o nome exibido, nunca o identificador (links e permissões continuam valendo).
- BR-5: quem cria o acervo passa a vê-lo; os demais só depois de liberados.

## Functional requirements
- FR-1: `POST /api/v1/topics` (permissão "Criar acervos") deve criar o acervo no vault com a mesma estrutura do `kb topic new` (topic.yaml, raw/, wiki/…), com `parent` opcional para sub-acervo. (BR-2, BR-4)
- FR-2: `PATCH /api/v1/topics/{slug}` deve mudar o nome e a descrição. (BR-4)
- FR-3: depois de criar ou renomear, a API deve recarregar o catálogo daquele acervo sem reiniciar. (Outcome)
- FR-4: o seletor "Acervo" deve mostrar a árvore: acervos em ordem alfabética, sub-acervos recuados sob o pai, com as contagens; escolher o pai mostra o conteúdo dele e dos sub-acervos, com o filtro "Sub-acervo" para restringir. (BR-3)
- FR-5: "Pessoas e permissões" deve mostrar a árvore de acervos para liberar por pessoa (acervo inteiro ou sub-acervo) e a permissão "Criar acervos". (BR-1, BR-3)
- FR-6: "Novo acervo" (na lateral, perto do seletor) abre um diálogo com nome, descrição e "Dentro de" (nenhum ou um acervo existente), com o identificador mostrado antes de criar.

## Non-functional requirements
- NFR-1: criar um acervo leva ≤ 2 s até aparecer no seletor de quem criou, medido no E2E.
- NFR-2: um nome repetido (mesmo identificador) é recusado com "Já existe um acervo com esse nome." sem criar nada pela metade.

## Acceptance criteria
- **AC-1** (FR-1, FR-6, BR-5): Given uma pessoa com "Criar acervos", When cria "UDV", Then "UDV" aparece no seletor dela em ≤ 2 s e a pasta `udv/` existe no vault com `topic.yaml`.
- **AC-2** (FR-1, BR-2): Given o acervo "UDV", When a pessoa cria "Palavra do Mestre" dentro dele, Then o seletor mostra "Palavra do Mestre" recuado sob "UDV".
- **AC-3** (BR-2): Given um sub-acervo, When alguém tenta criar outro dentro dele, Then a API recusa (400) e o diálogo nem oferece essa opção.
- **AC-4** (BR-1): Given uma pessoa sem "Criar acervos", When chama `POST /topics`, Then recebe 403 e "Novo acervo" não aparece para ela.
- **AC-5** (BR-3): Given acesso só a "Palavra do Mestre", When a pessoa abre o seletor, Then vê "UDV" como título do grupo, sem poder abrir o conteúdo próprio do pai, e "Palavra do Mestre" abre normalmente.
- **AC-6** (BR-4, FR-2): Given "UDV", When renomeado para "União do Vegetal", Then o endereço e as permissões continuam os mesmos.
- **AC-7** (NFR-2): Given "UDV", When alguém cria "udv" de novo, Then vê "Já existe um acervo com esse nome." e nada muda no vault.
- **AC-8** (acessibilidade): o diálogo e a árvore funcionam só com teclado, sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-3, AC-6, AC-7 | integração (API com vault temporário) + E2E | vault de fixture copiado por teste |
| AC-4, AC-5 | integração + E2E | duas contas |
| AC-8 | E2E | axe |

## References
Vault: `apps/api/src/adapters/fs-vault-adapter.ts` (limite de 2 níveis) · Catálogo: `modules/catalog` · Permissões: KBC-010, KBC-028 · Tela: `docs/design/screens.md` (lateral e Pessoas e permissões; a seção nova entra na spec do item)

## Decisões assumidas (o dono pode mudar)
- O conteúdo do pai inclui os sub-acervos na lista e na busca, com filtro para restringir (como uma pasta).
- Criar acervo cria também a coleção de busca vazia (QMD), para a busca não falhar no acervo novo.
- Já criados à mão em 2026-10-29: `udv` ("UDV") e `udv/palavra-do-mestre` ("Palavra do Mestre"); o sub-acervo só aparece com este item (hoje o leitor do vault não desce dentro de um acervo).

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done; no open questions
- [x] Fits one goal
