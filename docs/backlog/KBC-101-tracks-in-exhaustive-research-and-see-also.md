---
id: KBC-101
title: "Faixas como documentos na busca e no Exaustivo: lista de documentos, facetas e contagens da busca, \"Veja também\", varredura e cobertura, filtros de autoria e origem, sub-acervos"
status: ready
slice: phase-2-research-media
outcome: cada faixa transcrita é um documento do acervo também fora da conversa com a IA: aparece na lista de documentos da busca (T2), nas facetas e nas contagens, e abre a transcrição com o player; uma pergunta exaustiva sobre um acervo com faixas lê todas elas e diz quantas leu; quem lê um texto chega às faixas ligadas a ele
depends_on: [KBC-099, KBC-030]
parent: KBC-098
---

# KBC-101 — Faixas como documentos na busca, no "Veja também" e no Exaustivo

*Emenda 2026-11-07 (decisão do dono, conversa: "as faixas devem aparecer na lista de documentos, cada faixa transcrita é um «documento» do acervo"):* este item passa a incluir as faixas na lista de documentos da busca (T2), nas facetas e nas contagens, com ♪, abrindo o T22 com o player, sem repetir o que "Na fala" mostra (BR-6 a BR-11, FR-7 a FR-11, AC-10 a AC-20). Tira a exclusão do KBC-099 BR-7/FR-9. ADR 0035 emendada (§8) e telas T2 e T22.

## Story
Como quem pesquisa a obra inteira, quero que o Exaustivo varra também o que foi falado e me diga quantas faixas leu, para confiar que nada ficou de fora.

Como quem busca no acervo sem a IA, quero ver as faixas transcritas na lista de documentos, com as mesmas facetas e contagens dos textos, para achar o que foi falado como acho o que foi escrito e ouvir o trecho dali.

## Scope
**In:** faixas (e gravações transcritas sem faixas, KBC-100) na lista de documentos da busca (T2), nas facetas, nas contagens (resumo, "Autoria", "Buscar em", chips) e em "Mostrar mais", com o cartão ♪ e o clique que abre o T22 no trecho; uma faixa por cartão, juntando o documento dela e o trecho "Na fala" dela; faixas no conjunto da varredura (ADR 0021) e na cobertura medida pelo aplicativo; trecho resolvido pela citação literal dos achados (ADR 0035 §6 c); filtro `source` com a origem "Faixas de áudio" e `list_sources` com ela; `find_text`, leituras e varredura nos sub-acervos como `search_collection` já faz; faixas no "Veja também" do painel do documento, com ♪, abrindo o T22 no começo; as faixas como documentos do grupo de autoria certo nas fontes agrupadas (KBC-020).
**Out:** vídeo; níveis de acesso das faixas (KBC-106 aplica a regra de nível aqui também); mudar "Na fala" para as gravações cujas faixas não têm documento (continuam como hoje).

## Business rules
- BR-1: no Exaustivo, uma faixa visível (KBC-099 BR-4) é um documento do conjunto como um texto: entra no plano, no corte por expressões, nos lotes e na cobertura.
- BR-2: a cobertura separa as faixas: "2.700 documentos no conjunto (145 faixas de áudio)" e "· 412 analisados pela IA (30 faixas)".
- BR-3: o filtro de autoria vale para as faixas como para os textos; a origem "Faixas de áudio" restringe a elas, e `exclude` a tira.
- BR-4: um achado da varredura numa faixa resolve o trecho pela citação literal; sem achar a citação, pelo lote (o começo da janela lida).
- BR-5: o "Veja também" mostra faixas ligadas pelo `kb link` só a quem as veria na pesquisa (KBC-099 BR-4).
- BR-6: na busca de documentos (T2), uma faixa visível é um documento do acervo como um texto: entra na lista, nas facetas ("Assuntos", "Tipo de texto", "Profundidade", "Ligação com o tema", com os valores que o `kb classify` escreveu), nas contagens, em "Autoria", no filtro de sub-acervo e em "Mostrar mais". "Fora do tema" oculto por padrão vale para ela também.
- BR-7: visibilidade na T2: a faixa só aparece (e só conta) se o `media.db` a confirma na hora (existe, pronta, não arquivada, no mesmo acervo; ADR 0035 §5) e a pessoa tem acesso ao acervo, `media` e `media-tracks`. A T2 não é pesquisa com IA: `media-research` não é exigida aqui (decisão do planejamento, 2026-11-07: são as mesmas permissões com que a pessoa já vê a faixa na Biblioteca e em "Na fala"; nada novo é revelado). Quando os níveis de acesso chegarem às faixas (KBC-106), a regra de nível vale aqui também. Uma faixa escondida não aparece em nenhuma contagem.
- BR-8: cada faixa aparece no máximo uma vez por mensagem de resultados: quando o documento dela e um trecho "Na fala" dela batem, vira um cartão só, o da faixa, com o minuto e a frase do trecho "Na fala" e as facetas do documento, na melhor das duas posições. O mesmo vale para a gravação sem faixas e o documento dela. Um trecho "Na fala" de gravação cuja faixa não tem documento visível continua como hoje.
- BR-9: em "Buscar em", as faixas contam em "♪ Áudios" (não em "Textos"): desmarcar "Áudios" tira as faixas e os trechos; cada faixa conta uma vez.
- BR-10: faixas nunca se agrupam como "cópias" de um texto nem de outra faixa (o agrupamento por título normalizado vale só entre textos).
- BR-11: o cartão da faixa abre o T22 no trecho que bateu (o do "Na fala" quando houve junção; senão o do trecho do índice, pela âncora anterior; senão o começo da faixa), com o player pausado em −2 s.

## Functional requirements
- FR-1: `SweepPlanner.targetSet` e `measureSweep` devem incluir as entradas de faixa visíveis e contar `tracks` em `sweepCoverageSchema` (aditivo). (BR-1, BR-2)
- FR-2: `batchText` deve rotular faixas como "faixa de áudio" com gravação e manter as âncoras. (BR-1)
- FR-3: `FindingSet` deve resolver o trecho de um achado de faixa pela citação (sem marcação de link do kb), senão pelo começo da janela. (BR-4)
- FR-4: `filterShape.source` deve aceitar `faixas-de-audio`, e `list_sources` deve listá-la com a contagem. (BR-3)
- FR-5: `find_text`, `read_document(s)`, `list_sources` e a varredura devem usar o escopo com sub-acervos (`catalog.scope`). (BR-1)
- FR-6: `GET /topics/:topic/documents/:id` deve trazer, em "Veja também", as faixas visíveis com `media`, e a web deve abri-las no T22. (BR-5)
- FR-7: A busca de documentos (`GET /topics/:topic/search` e as facetas, sugestões e contagens) deve incluir as entradas de faixa que passam pelo BR-7, filtradas antes de calcular facetas, totais e páginas; a exclusão do KBC-099 FR-9 sai. (BR-6, BR-7)
- FR-8: o resultado da busca deve ganhar, de forma aditiva, `media? { mediaId, kind, recordingTitle, ordinal?, total?, startMs, confidence, stale }` no item, e o trecho nunca mostra frontmatter nem a marcação das âncoras. (BR-6, BR-11)
- FR-9: a busca deve juntar o documento de uma faixa e o trecho "Na fala" da mesma faixa (ou da mesma gravação sem faixas) num só item antes de paginar e contar. (BR-8)
- FR-10: "Buscar em" deve contar as faixas em "Áudios", uma vez cada, e a escolha deve incluí-las ou tirá-las. (BR-9)
- FR-11: a web deve mostrar o cartão da faixa (T2): "♪ Faixa · <gravação> · faixa 3 de 12 · 8:15", título, trecho, facetas em texto, selo de autoria, "⚠ baixa confiança" e "· atualizando" quando for o caso; o clique ou Enter abre o T22 no trecho. (BR-6, BR-11)

## Non-functional requirements
- NFR-1: com 2.000 faixas a mais, o planejamento e o corte por expressões do Exaustivo levam no máximo +15 % (vault de teste, sem modelo).
- NFR-2: a estimativa do Exaustivo continua exata: pedidos previstos = pedidos feitos ± 1 no teste com faixas.
- NFR-3: a busca de documentos (T2) com 2.000 faixas a mais no acervo de teste fica no máximo +10 % no p95 por modo (`pnpm --filter @kb-chat/api latency`), contando a conferência no `media.db`.
- NFR-4: o cartão da faixa na T2: 390 px sem rolagem lateral; WCAG 2.2 AA, axe sem violações sérias nos três temas; o ♪ sempre com texto ("Faixa de áudio" ao leitor de tela).

## Acceptance criteria
- **AC-1** (BR-1, BR-2, FR-1): Given um acervo de teste com 6 textos e 3 faixas e o stub do Exaustivo sem expressões, When a pergunta varre o acervo, Then os 9 documentos são lidos e a cobertura diz "9 documentos no conjunto (3 faixas de áudio) · 9 lidos por inteiro pela IA (3 faixas)".
- **AC-2** (BR-1, borda): Given expressões que só aparecem numa faixa, Then só ela vai a um lote e a cobertura conta as outras como conferidas pelas expressões.
- **AC-3** (BR-3): Given autoria "Mestre Laércio" e uma faixa de outros autores com a expressão, Then a faixa fica fora do conjunto; com "Faixas de áudio", só faixas entram.
- **AC-4** (BR-4, FR-3): Given um achado com a citação de uma fala de 3:10, Then a fonte traz `passages[0].startMs` daquela fala; Given uma citação que não está no texto, Then o trecho é o começo da janela lida.
- **AC-5** (BR-1, negativo): Given alguém sem `media-research`, When roda o Exaustivo, Then o conjunto e a cobertura não têm faixas e nada diz "faixas".
- **AC-6** (FR-5): Given uma faixa num sub-acervo, When a pesquisa é no acervo pai, Then `find_text` e a varredura a acham.
- **AC-7** (BR-5, FR-6): Given um texto ligado a uma faixa pelo `kb link`, When a pessoa abre o texto, Then "Veja também" mostra "♪ <título da faixa> · <gravação>", e o clique abre o T22 no começo, com "← Voltar" ao texto; sem `media-research`, a faixa não aparece.
- **AC-8** (continuação): Given uma varredura incompleta com faixas, When **Continuar varredura**, Then retoma depois da última faixa ou texto varrido e a cobertura soma as faixas.
- **AC-9** (KBC-098 ponto 7): Given os specs de pesquisa exaustiva e de busca existentes, Then passam sem mudança, exceto o que este item muda de propósito (faixas na T2, KBC-099 AC-13 trocado pelo AC-10).
- **AC-10** (BR-6, FR-7, FR-11): Given um acervo com 6 textos e a faixa "O que é o ritmo?" publicada (faixa 3 de 12) cujo documento fala de "ritmo", When alguém com `media` e `media-tracks` busca "ritmo" em "Buscar documentos", Then a lista mostra o cartão "♪ Faixa · Palestra de 12/03/2017 · faixa 3 de 12 · 0:41" entre os textos, pela relevância, e o resumo conta "7 documentos (1 faixa)".
- **AC-11** (BR-6, facetas): Given a faixa classificada pelo kb como "Aula ou palestra · Intermediário · Central" com o assunto "Cosmologia Espiritual", Then os chips contam a faixa nesses valores; When a pessoa escolhe "Profundidade: Aprofundado", Then a faixa some e as contagens mudam junto; "Fora do tema" esconde a faixa fora do tema por padrão e a nota "N ocultos" a conta.
- **AC-12** (BR-6, autoria e sub-acervo): Given uma faixa de "Outros autores" num sub-acervo, Then "Autoria" a conta em "Outros autores", o cartão tem o selo e "em <sub-acervo>", e o filtro "✦ Mestre Laércio" a tira.
- **AC-13** (BR-7, permissão): Given alguém sem `media` ou sem `media-tracks` (ou sem acesso ao acervo), When busca o mesmo, Then nenhuma faixa aparece, nenhuma contagem, faceta, "Autoria" ou "Buscar em" a conta, e "Buscar em" não aparece se não houver áudio que a pessoa possa ouvir; Given alguém com `media` e `media-tracks` e sem `media-research`, Then a faixa aparece na T2 (e continua fora da pesquisa com IA).
- **AC-14** (BR-7, borda): Given a faixa arquivada (ou apagada, ou movida para outro acervo) depois de publicada, com o arquivo ainda no vault, When alguém busca, Then ela não aparece nem conta no acervo antigo; movida, aparece só no acervo novo depois de publicada lá.
- **AC-15** (BR-8, FR-9, junção com "Na fala"): Given "ritmo" no documento da faixa e na fala dela aos 8:15, When a pessoa busca "ritmo" com "Buscar em: Textos · Áudios", Then há um só cartão da faixa com "8:15" e a frase da fala em `<mark>`, nenhum cartão "Na fala" repetido dela, e o resumo não a conta duas vezes.
- **AC-16** (BR-8, borda): Given uma gravação sem faixas com documento (KBC-100) e um trecho "Na fala" dela, Then aparece um só cartão da gravação; Given uma gravação com faixas ainda sem documento, Then o trecho "Na fala" aparece como hoje.
- **AC-17** (BR-9, FR-10): Given "Buscar em" com só "Textos" marcado, Then nenhuma faixa aparece; com só "Áudios", só faixas e trechos; a contagem de "♪ Áudios" conta cada faixa uma vez.
- **AC-18** (BR-10): Given um texto e uma faixa com o mesmo título, Then são dois cartões, sem "+1 cópia".
- **AC-19** (BR-11, FR-11, teclado e leitor de tela): Given o cartão da faixa do AC-15, When a pessoa usa Enter nele, Then o T22 abre com a fala de 8:15 destacada e o player pausado em 8:13, e o foco volta ao cartão ao fechar; o leitor de tela ouve "Faixa de áudio, O que é o ritmo?, aos 8 minutos e 15 segundos".
- **AC-20** (FR-8, FR-11, estados): Given uma faixa de baixa confiança e uma "atualizando", Then os cartões mostram "⚠ baixa confiança" e "· atualizando"; Given 390 px, Then o cartão cabe sem rolagem lateral e o T22 abre em tela cheia.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-6, AC-8 | integração | `sweep-tracks.integration.test.ts` no vault de fixture com faixas e `media.db` semeado; stub de lote |
| AC-4 | unidade | `findings.test.ts` com a resolução pela citação |
| AC-7 | componente + E2E | `document-panel.spec.ts`; `e2e/specs/research-tracks.spec.ts` estendido |
| AC-9 | E2E existentes | sem mudança, salvo o AC-13 do KBC-099 trocado |
| AC-10 a AC-18 | integração API | `search-tracks.integration.test.ts` no vault de fixture com documentos de faixa e `media.db` semeado; permissões; arquivada/movida; junção com "Na fala" |
| AC-15, AC-17, AC-18 | unitário | junção e contagem (`merge-track-hits.test.ts`), agrupamento de cópias |
| AC-10, AC-19, AC-20 | componente + E2E | `result-card.spec.ts`; `e2e/specs/search-tracks.spec.ts`, 1440 e 390 px, axe nos três temas |
| NFR-3 | script | `pnpm --filter @kb-chat/api latency` com 2.000 faixas sintéticas, evidência em `work/KBC-101/` |
| NFR-1, NFR-2 | script | medida sem modelo no vault de teste, evidência em `work/KBC-101/` |

## References
ADR [0035](../adr/0035-tracks-as-kb-documents.md), [0021](../adr/0021-app-driven-exhaustive-sweep.md), [0015](../adr/0015-authorship-in-catalog-and-tool-contracts.md) · Telas T2 (cartão da faixa, junção com "Na fala", emenda de 2026-11-07), T22 (aberta da T2), T4 (cobertura) e T3 ("Veja também") com as emendas de 2026-11-05 · ADR 0035 §5 e §8 (emenda de 2026-11-07) · Níveis: ADR 0036, KBC-106.

## Open questions
Nenhuma. Decisão do dono de 2026-11-07 (conversa): as faixas entram na lista de documentos da T2, nas facetas e nas contagens. Premissa do planejamento (o dono pode mudar): na T2 bastam `media` e `media-tracks`, sem `media-research` (BR-7).

## Definition of ready
- [x] Story, escopo e resultado
- [x] Cada BR e FR com AC; negativos e bordas
- [x] NFRs medidos
- [x] Nível de teste em cada AC
- [x] ADR e tela
- [x] Depende do KBC-099
- [x] Cabe num goal (maior depois da emenda de 2026-11-07; se o goal não couber, dividir em "T2" e "Exaustivo e Veja também")
