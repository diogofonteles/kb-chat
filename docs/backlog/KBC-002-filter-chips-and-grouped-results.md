---
id: KBC-002
title: Filtrar resultados por facetas com contagens
status: done
slice: release-1
outcome: % de sessões com filtro; % de buscas que abrem documento
depends_on: [KBC-001]
---

# KBC-002 — Filtrar resultados por facetas com contagens

## Story

Quando a busca traz documentos demais, quero refinar por assunto, tipo de texto, profundidade e ligação com o tema clicando em chips, para chegar ao material certo sem decorar flags.

## Scope

**In:**
- Filtros no contrato de busca e catálogo completo (facetas, relações, grupos de cópias), com over-fetch e pós-filtro (ADR 0003).
- Contagens por faceta sobre o conjunto de resultados.
- Chips com popover multi-seleção, chip ativo com "×" e tela de filtros no celular com "Aplicar".
- "Mostrar mais" (cursor), agrupamento de cópias ("+n cópias") e "Fora do tema" oculto por padrão.
- `GET /api/v1/topics/{topic}/facets`.

**Out:**
- Ordenação e filtros por data (release 2).

## Business rules

- BR-1: As facetas e os nomes em pt-BR seguem o vocabulário de `docs/design/screens.md`. Um valor com 0 documentos no acervo não vira opção.
- BR-2: Por padrão, os documentos com relevance `off_topic` ficam fora dos resultados. A opção "Fora do tema" fica desmarcada e o chip mostra "<n> ocultos". Exceção: se o usuário marcar "Fora do tema", eles entram.
- BR-3: Valores marcados da mesma faceta combinam com OU; facetas diferentes combinam com E.
- BR-4: Documentos com o mesmo título normalizado (minúsculas, sem acentos, espaços colapsados e sem sufixo `-n` no nome do arquivo) formam um grupo; a lista mostra o membro de maior pontuação com "+<n-1> cópias".
- BR-5: Concepts com caminho (por exemplo, `hermetismo/wiki/concepts/Cabala`) são exibidos e filtrados pelo nome final ("Cabala") e unificados com o nome simples.

## Functional requirements

- FR-1: Quando a busca tem filtros, a API deve buscar até 200 hits no índice, aplicar os filtros pelo catálogo e devolver 10 itens, `total` e `nextCursor` (BR-3).
- FR-2: A API deve devolver, junto aos itens, as contagens por valor de cada faceta, calculadas sobre os resultados filtrados pelas demais facetas (BR-1, BR-3).
- FR-3: Quando o usuário marca ou desmarca um valor num chip, a web deve refazer a busca na mesma mensagem e mostrar o chip ativo com o texto "<Faceta>: <valor>" e "×".
- FR-4: Quando o usuário clica em "Mostrar mais", a web deve anexar os próximos 10 itens até o máximo de 50.
- FR-5: Quando um grupo de cópias é expandido, a web deve listar as cópias, cada uma abrível (BR-4).
- FR-6: No celular (< 1024 px), "Filtros (<n>)" deve abrir uma tela cheia com "Aplicar" fixo e "Cancelar", sem aplicar a cada toque (SL-21).
- FR-7: Quando os filtros zeram os resultados, a web deve oferecer "Remover <último filtro>" (SL-14).
- FR-8: A API deve recusar um campo ou valor de filtro fora da lista permitida com 400 `VALIDATION_FAILED` (CS-10).

## Non-functional requirements

- NFR-1: o pós-filtro e as contagens somam ≤ 50 ms para 200 hits no catálogo de 4.235 documentos (teste de desempenho unitário).

## Acceptance criteria

- **AC-1 (FR-1, BR-3)**
  - Given 3 hits de "Cabala", dos quais 2 são "Aula ou palestra"
  - When o usuário filtra Assuntos = Cabala e Tipo = Aula ou palestra
  - Then aparecem só esses 2
- **AC-2 (BR-3)**
  - Given Tipo = "Aula ou palestra" ou "Guia prático" marcados
  - When a busca roda
  - Then aparecem documentos de ambos os tipos
- **AC-3 (FR-2)**
  - Given resultados
  - When o popover de Assuntos abre
  - Then cada opção mostra a contagem coerente com os resultados
- **AC-4 (BR-2)**
  - Given um hit `off_topic`
  - When a busca roda sem filtros
  - Then ele não aparece e o chip informa "1 oculto"
- **AC-5 (BR-2, exceção)**
  - Given "Fora do tema" marcado
  - When a busca roda
  - Then o hit `off_topic` aparece
- **AC-6 (BR-4, FR-5)**
  - Given `a-natureza-s-tupla-2.md` e `-5.md` com o mesmo título
  - When ambos aparecem
  - Then há 1 cartão com "+1 cópia", que expande e mostra as duas
- **AC-7 (BR-5)**
  - Given documentos com `hermetismo/wiki/concepts/Cabala` e `Cabala`
  - When o popover abre
  - Then aparece uma única opção "Cabala" com a soma
- **AC-8 (FR-3)**
  - Given um chip ativo
  - When o usuário clica no "×"
  - Then o filtro sai e a lista se refaz na mesma mensagem
- **AC-9 (FR-4)**
  - Given 23 resultados
  - When o usuário clica em "Mostrar mais" duas vezes
  - Then aparecem 23 e o botão some
- **AC-10 (FR-6)**
  - Given 390 px de largura
  - When o usuário marca valores na tela de filtros e toca em "Cancelar"
  - Then nada muda
  - And, ao tocar em "Aplicar", os filtros valem
- **AC-11 (FR-7)**
  - Given filtros que zeram os resultados
  - When a busca termina
  - Then aparece "Remover <filtro>" e, ao clicar, os resultados voltam
- **AC-12 (FR-8, negativo)**
  - Given o filtro `{ "path": "x" }`
  - When a API recebe a busca
  - Then responde 400 `VALIDATION_FAILED`

## Test strategy

| AC | Nível | Notas |
|---|---|---|
| AC-1–AC-7, AC-12, NFR-1 | Unit/integração (api: catalog, search) | fixtures de frontmatter |
| AC-3, AC-8–AC-11 | E2E Playwright | vault de fixture |

## References

- Screen spec: `docs/design/screens.md` (T2: chips, cartão, estados).
- ADR 0003.

## Open questions

Nenhuma.

## Definition of ready

- [x] Story, scope e outcome
- [x] BR/FR cobertos por AC, com negativos
- [x] NFRs mensuráveis
- [x] Nível de teste por AC
- [x] Referências de UI e arquitetura
- [x] Dependências agendadas, sem perguntas abertas
- [x] Cabe num goal
