---
id: KBC-049
title: "Autores livres: informar o autor ao enviar, com um autor principal por acervo"
status: ready
slice: phase-2-a
outcome: quem envia informa o autor real de cada áudio e documento (por exemplo, "Mestre Gabriel" na UDV), e a busca, os filtros e a IA usam esse autor
depends_on: [KBC-048]
---

# KBC-049 — Autores livres por acervo

## Story
Como quem envia conteúdo, quero informar o autor de cada áudio (escolhendo um já cadastrado ou digitando um novo), para que cada acervo tenha os seus autores e não só "Mestre Laércio" e "Outros autores".

## Scope
**In:** lista de autores por acervo; ao enviar, campo "Autor" com sugestões dos autores do acervo e a opção de cadastrar um novo; um "autor principal" por acervo (o mestre daquela tradição); o filtro de autoria e os selos mostram os autores reais; migração das duas autorias de hoje.
**Out:** fundir autores repetidos com nomes diferentes (fica para depois); autoria de documentos já classificados pelo `kb classify` além do mapeamento abaixo.

## Business rules
- BR-1: cada acervo tem sua lista de autores; um sub-acervo usa a lista do acervo pai.
- BR-2: cada acervo pode ter um autor principal; a regra da IA de hoje (nunca atribuir ao Mestre Laércio o que é de outro autor, KBC-020) passa a valer para o autor principal de cada acervo.
- BR-3: cadastrar um autor novo exige a permissão de enviar conteúdo naquele acervo.
- BR-4: o que existe hoje continua igual: no acervo "Hermetismo", "Mestre Laércio" vira o autor principal e "Outros autores" continua como valor para o que não tem autor informado.

## Functional requirements
- FR-1: `GET/POST /api/v1/topics/{slug}/authors` deve listar e cadastrar autores do acervo (nome; o identificador sai do nome). (BR-1, BR-3)
- FR-2: `PATCH /api/v1/topics/{slug}` deve aceitar o autor principal. (BR-2)
- FR-3: o envio de áudio deve pedir "Autor" (combobox com sugestões e "Cadastrar «nome»"), no lugar da escolha fixa de hoje.
- FR-4: o filtro "Autoria" e os selos devem mostrar o autor principal com ✦ e os demais pelo nome, com "Outros autores" agrupando os sem autor. (BR-2, BR-4)
- FR-5: a migração deve converter `mestre-laercio` e `outros-autores` sem perder nada. (BR-4)

## Non-functional requirements
- NFR-1: as sugestões aparecem em ≤ 100 ms com 500 autores no acervo.

## Acceptance criteria
- **AC-1** (FR-3, FR-1): Given o acervo "UDV" sem autores, When a pessoa envia um áudio e digita "Mestre Gabriel", Then o autor é cadastrado e o áudio mostra o selo "Mestre Gabriel".
- **AC-2** (FR-2, BR-2): Given "Mestre Gabriel" como autor principal da UDV, When a IA responde com fontes da UDV, Then nunca atribui a ele o que está em fontes de outros autores.
- **AC-3** (BR-1): Given "Palavra do Mestre" dentro da UDV, When a pessoa envia nele, Then as sugestões são as da UDV.
- **AC-4** (BR-3): Given uma pessoa sem permissão de enviar, When chama `POST …/authors`, Then recebe 403.
- **AC-5** (FR-5, BR-4): Given os dados de hoje, When a migração roda, Then o Hermetismo mostra "✦ Mestre Laércio" e "Outros autores" como antes, nas buscas e na mídia.
- **AC-6** (acessibilidade): o combobox segue o padrão APG, sem violações sérias do axe em 1440 e 390 px nos três temas.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-3, AC-4 | integração + E2E | |
| AC-2 | unitário do prompt + integração com LLM stub | |
| AC-5 | integração da migração com dados de hoje | |
| AC-6 | E2E | axe |

## References
Autoria hoje: KBC-020 e `libs/contracts` (`MEDIA_AUTHORSHIPS`) · Prompt: `apps/api/src/modules/research/prompt.ts` · Tela: `docs/design/screens.md` (Autoria, T14 envio)

## Decisões assumidas (o dono pode mudar)
- Autores ficam por acervo (não uma lista global): cada tradição tem seus mestres e autores.
- Os documentos do vault continuam com a autoria do `kb classify`; o mapeamento novo vale para eles pelo autor principal do acervo.

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
