---
id: KBC-108
title: "Gerir a escala de níveis: apagar com reatribuição, reordenar com a prévia do impacto, tirar todos os níveis e o \"Histórico de níveis\""
status: ready
slice: levels-release-2
outcome: o master muda a escala sem abrir ou fechar conteúdo por engano, porque vê antes quem ganha e quem perde acesso, e consegue responder "quem mudou o nível disto e quando"
depends_on: [KBC-103, KBC-105]
parent: LEVELS
---

# KBC-108 — Gerir a escala e o histórico

## Story
Como master, quero apagar, reordenar ou tirar níveis vendo antes o impacto, e consultar o histórico de mudanças, para manter a escala certa sem surpresas e com rastro.

## Scope
**In:** **Apagar nível** na T24 com reatribuição obrigatória (conteúdo para: padrão o nível seguinte, mais restrito; pessoas para: padrão o anterior) e a prévia "12 documentos, 3 áudios e 4 pessoas estão em CI"; **Mover** com prévia do impacto ("2 pessoas passam a ver 14 itens; 1 pessoa deixa de ver 6") antes de confirmar; **Tirar todos os níveis** com confirmação digitando o nome do acervo; **Histórico de níveis** (T24): lista paginada da auditoria com filtros (quem, tipo, período, item ou pessoa), "agia como" visível.
**Out:** desfazer automático (o histórico mostra o antes para refazer à mão).

## Business rules
- BR-1: um nível com conteúdo ou pessoas só é apagado com destino escolhido para cada um, na mesma operação.
- BR-2: o padrão do destino é: conteúdo para o nível imediatamente acima (se o apagado é o mais alto, o imediatamente abaixo) e pessoas para o imediatamente abaixo (se é o mais baixo, o imediatamente acima).
- BR-3: reordenar e apagar mostram a prévia do impacto calculada no servidor e só aplicam se a escala não mudou desde a prévia (409 `LEVELS_CHANGED`).
- BR-4: tirar todos os níveis volta o acervo ao comportamento sem escala (todos com acesso veem tudo), apaga as entradas de nível do acervo e é auditado; pede o nome do acervo.
- BR-5: o histórico é só para masters e mostra quem, quando, o quê, antes → depois, e quem agia como quem.

## Functional requirements
- FR-1: `DELETE /api/v1/topics/:topic/levels/:id` com `{ moveContentTo, movePeopleTo, version }`. (BR-1, BR-2, BR-3)
- FR-2: `POST …/levels/preview` com a ordem ou a remoção pretendida devolve as contagens por pessoa e por tipo, sem títulos. (BR-3)
- FR-3: `DELETE …/levels` (todos) com `{ confirm: <slug>, version }`. (BR-4)
- FR-4: `GET /api/v1/levels/audit?topic&actor&kind&from&to&cursor` lê os arquivos mensais. (BR-5)
- FR-5: a escala ganha `version`, incrementada a cada escrita. (BR-3)

## Non-functional requirements
- NFR-1: a prévia de um acervo com 10.000 documentos, 2.000 áudios e 500 pessoas responde p95 ≤ 300 ms.
- NFR-2: apagar um nível com 5.000 itens é atômico: uma falha no meio deixa tudo como antes (teste com falha injetada).

## Acceptance criteria
- **AC-1** (BR-1, BR-2): Given QS < CI < CDC com 12 documentos, 3 áudios e 4 pessoas em CI, When o master apaga CI aceitando os padrões, Then os 15 itens vão para CDC, as 4 pessoas para QS, e a auditoria tem a operação.
- **AC-2** (BR-1, negativo): Given a API chamada sem `moveContentTo`, Then 400 e nada muda.
- **AC-3** (BR-3): Given a prévia de mover CDC para baixo de CI, Then diz quantas pessoas passam a ver quantos itens; Given outro master mudou a escala depois da prévia, When confirma, Then 409 "A escala mudou. Confira de novo.".
- **AC-4** (BR-4): Given "Tirar todos os níveis", When o nome digitado não confere, Then o botão fica desabilitado; quando confere, Then o acervo volta a não ter escala e Ana vê tudo.
- **AC-5** (BR-5): Given 3 mudanças de nível, uma delas feita por um master agindo como outro, When o master abre o histórico filtrando por item, Then vê as 3 com antes → depois e "agindo como"; um membro recebe 403.
- **AC-6** (borda): Given apagar o único nível de um acervo, Then vale como "Tirar todos os níveis" e pede o nome do acervo.
- **AC-7** (NFR-2): Given uma falha injetada no meio da gravação, Then os arquivos e o `media.db` ficam como antes.
- **AC-8** (UI): Given 390 px, Then a prévia e os destinos aparecem antes do botão de confirmação, com o foco nele ao abrir (MA-27), e o histórico pagina por toque.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-7 | integração | `levels-manage.integration.test.ts`, falha injetada no adaptador |
| AC-8 | E2E | `e2e/specs/levels.spec.ts`, 1440 e 390, axe |
| NFR-1 | teste de desempenho | — |

## References
ADR [0036](../adr/0036-access-levels-per-collection.md) §10, §11 · Tela T24 ("Apagar nível", "Mover", "Histórico de níveis").

## Open questions
Nenhuma bloqueante. Decisão assumida (o dono pode mudar): destinos padrão de BR-2.

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR e tela
- [x] Depende do KBC-103 e do KBC-105
- [x] Cabe num goal
