---
id: KBC-020
title: "Autoria: Mestre Laércio × outros autores na busca, nas fontes e na pesquisa com IA"
status: done
slice: release-1
outcome: o leitor sempre sabe se um documento é do Mestre Laércio, de outro autor ou uma síntese do acervo; pode filtrar por autoria; a IA nunca atribui ao Mestre a ideia de outro autor
depends_on: [KBC-002, KBC-003, KBC-017]
---

# KBC-020 — Autoria: Mestre Laércio × outros autores

## Story
Como dono do acervo, quero que a obra de José Laércio do Egito (o Mestre Laércio) fique sempre separada dos livros de outros autores, na busca, no painel, nas fontes e nas respostas da IA, para que nenhum ensinamento seja atribuído a quem não o escreveu.

Pedido do dono em 2026-10-26: o núcleo do acervo são as pastas Temas-doc, Temas-docs e Temas-doc 2 e o material relacionado; o resto são livros de outros autores. O vault já marca cada fonte bruta com `author_group` (`mestre-laercio`, com `author: José Laércio do Egito`, ou `outros-autores`), mantido pelo dono (`_tools/mark-authorship.py`). Os artigos do wiki não têm a chave: são sínteses do acervo.

## Scope
**In:**
- Catálogo lê `author_group` e `author` do frontmatter; contrato `authorship` com quatro valores (`mestre-laercio`, `outros-autores`, `sintese`, `nao-classificado`) e `author` opcional, nos resultados, no documento e nas fontes da resposta.
- Busca: controle segmentado "Autoria" (Todos · Mestre Laércio · Outros autores) com contagens, junto dos filtros; selo de autoria nos cartões e no painel do documento.
- Pesquisa com IA: rótulo de autoria em toda linha de documento das ferramentas; filtro `authorship` em `search_collection`, `find_text` e `list_sources`; `list_sources` conta documentos por autoria; regra de autoria no prompt de todos os perfis, do sub-pesquisador e dos caminhos por token e por assinatura (MCP).
- Fontes da resposta com selo e agrupadas por autoria quando misturam grupos.
- Histórico: os turnos salvos guardam a autoria das fontes; turnos antigos sem ela aparecem sem selo.

**Out:**
- Editar ou adivinhar a autoria (é do dono, no vault). Nada é escrito no vault.
- Autoria nos itens de "Veja também" e nas sugestões do início.
- Outros autores nomeados um a um no filtro da busca (o filtro por entidade da IA já cobre isso).

## Business rules
- BR-1: a autoria vem só do frontmatter: `author_group: mestre-laercio` → Mestre Laércio; `outros-autores` → Outros autores; sem a chave (ou com valor desconhecido), um artigo do wiki → Síntese do acervo e qualquer outro documento → Não classificado. Nunca se adivinha pela pasta, pelo título ou pelas entidades.
- BR-2: "Todos" inclui as quatro autorias; "Mestre Laércio" e "Outros autores" mostram só o seu grupo.
- BR-3: o selo do Mestre Laércio se distingue por forma, ícone e texto, não só por cor.
- BR-4: a IA atribui ao Mestre só o que está em documentos de autoria Mestre Laércio, rotula citações de outros autores com o autor ou o livro, nunca apresenta a ideia de outro autor como do Mestre e, numa pergunta sobre o Mestre, pesquisa primeiro só nos documentos dele.
- BR-5: uma conversa salva antes desta mudança abre sem selo e sem erro.

## Functional requirements
- FR-1: `CatalogEntry`, `SearchHit` e `KbDocument` ganham `authorship` e `author` (string ou null); `AnswerSource` ganha `authorship` e `author` opcionais. (BR-1, BR-5)
- FR-2: `SearchFilters` ganha `authorships` (padrão vazio; conversas salvas sem ele continuam válidas) e `ResultFacets` ganha `authorships` com contagens disjuntivas. (BR-2)
- FR-3: a barra de filtros mostra o controle "Autoria" (grupo de rádio) com "Todos (n)", "Mestre Laércio (n)", "Outros autores (n)"; a opção com 0 resultados fica desabilitada, salvo se já estiver escolhida; nos telefones o controle ocupa uma linha própria acima dos chips. (BR-2)
- FR-4: cartão de resultado, painel do documento e fonte da resposta mostram o selo de autoria; no painel, também o autor quando o frontmatter o informa. (BR-3)
- FR-5: as linhas de documento de `search_collection`, `find_text` (files, count, content), `read_document(s)`, `related_documents` trazem "autoria: <rótulo>"; `search_collection`, `find_text` e `list_sources` aceitam `authorship`; `find_text` sem `phrase` lista todos os documentos de uma autoria; `list_sources` abre com a contagem por autoria. (BR-4)
- FR-6: o prompt de pesquisa (Rápido, Profundo, Exaustivo), o do sub-pesquisador e o da assinatura trazem a regra de autoria. (BR-4)
- FR-7: as fontes citadas aparecem agrupadas "Mestre Laércio" / "Outros autores" / "Síntese do acervo" / "Não classificado" quando há mais de um grupo; com um grupo só, ou com alguma fonte sem autoria (conversa antiga), a lista fica como antes. (BR-5)

## Non-functional requirements
- NFR-1: WCAG 2.2 AA no controle e nos selos (rádio nativo, foco visível, contraste ≥ 4,5:1), em 1440 e 390 px, sem rolagem horizontal.
- NFR-2: nenhuma chamada paga de LLM nos testes; o vault real é só lido.
- NFR-3: o catálogo real conta 2.555 Mestre Laércio, 392 Outros autores e os artigos do wiki como Síntese.

## Acceptance criteria
- **AC-1 (FR-1, BR-1)**
  - Given documentos com `author_group: mestre-laercio` (+ `author`), `outros-autores`, um artigo do wiki sem a chave e uma fonte sem a chave (ou com valor desconhecido)
  - When o catálogo é carregado
  - Then as autorias são Mestre Laércio (com o autor), Outros autores, Síntese do acervo e Não classificado
- **AC-2 (FR-2, FR-3, BR-2)**
  - Given uma busca com resultados dos quatro grupos
  - When o leitor escolhe "Mestre Laércio" no controle Autoria
  - Then só aparecem documentos do Mestre, o controle mostra as contagens de cada opção (Todos = soma) e "Todos" volta a mostrar tudo
- **AC-3 (FR-4, BR-3)**
  - Given um resultado do Mestre e um de outro autor
  - When o leitor vê os cartões e abre o documento
  - Then cada cartão e o painel mostram o selo com o texto da autoria; o do Mestre tem ícone e fundo cheio, o de outros autores é contornado
- **AC-4 (FR-5)**
  - Given o agente chama `find_text` com `authorship: "mestre-laercio"` (com e sem `phrase`) e `list_sources`
  - When as ferramentas respondem
  - Then só documentos do Mestre aparecem, cada linha traz "autoria: Mestre Laércio" e `list_sources` mostra a contagem por autoria; um valor de `authorship` inválido volta como erro de argumentos
- **AC-5 (FR-5)**
  - Given `search_collection` com `authorship: "outros-autores"`
  - When a busca responde
  - Then só documentos de outros autores aparecem, rotulados
- **AC-6 (FR-6, BR-4)**
  - Given qualquer perfil, o sub-pesquisador e o prompt da assinatura
  - When o prompt é montado
  - Then ele traz a regra de autoria (atribuir ao Mestre só os documentos dele; rotular outros autores; perguntas sobre o Mestre filtram primeiro por `mestre-laercio`)
- **AC-7 (FR-1, FR-7)**
  - Given uma resposta que cita documentos do Mestre e de outros autores
  - When ela termina
  - Then as fontes aparecem em grupos "Mestre Laércio" e "Outros autores", cada uma com o selo, e o turno salvo guarda a autoria
- **AC-8 (BR-5)**
  - Given uma conversa salva sem autoria nas fontes e uma busca salva sem `authorships`
  - When o leitor a abre
  - Then ela aparece sem selo, sem grupos e sem erro

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | unitário (`catalog-entry.test.ts`) + integração (catálogo da fixture) | fixture com os quatro casos |
| AC-2 | unitário (`refine.test.ts`, `filter-bar.spec`) + E2E (`filters.spec.ts`) | vault de fixture, 1440 e 390 px |
| AC-3 | unitário (`result-card.spec`, `document-panel.spec`) + E2E | — |
| AC-4, AC-5 | unitário (`grep-tool.test.ts`, `sources-tool.test.ts`, `tools.test.ts`) | catálogo em memória |
| AC-6 | unitário (`prompt.test.ts`, `cli-runners.test.ts`) | — |
| AC-7 | unitário (`research-message.spec`) + E2E (`research.spec.ts`, provedor falso) | — |
| AC-8 | unitário (`conversations.test.ts`, `research-message.spec`) | dados antigos |

## References
ADR: `docs/adr/0015-authorship-in-catalog-and-tool-contracts.md` (emenda 0003, 0006, 0013) · Telas: `docs/design/screens.md` (T2, T3, T4: autoria) · Vault: `hermetismo/CLAUDE.md` "## Authorship"

## Open questions
Nenhuma. Premissas: "Todos" é o padrão; a síntese e o não classificado só aparecem em "Todos"; o selo do Mestre usa o acento do tema com o ícone ✦.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
