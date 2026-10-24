---
id: KBC-003
title: Ler com trecho destacado e "Veja também"
status: ready
slice: release-1
outcome: % de buscas que abrem documento; profundidade de navegação
depends_on: [KBC-001]
---

# KBC-003 — Ler com trecho destacado e "Veja também"

## Story

Quando abro um documento encontrado, quero cair direto no trecho que bate com a pergunta e ver os documentos ligados a ele, para estudar sem procurar dentro do texto.

## Scope

**In:**
- Destaque dos termos da busca no corpo, com rolagem até a 1ª ocorrência e a navegação "1 de n ▲▼".
- Resumo recolhível.
- Assuntos como chips que filtram a conversa.
- "Veja também" com os grupos "É exemplo de", "Aprofunda" e "Relacionados".
- Navegação com "← Voltar" dentro do painel.
- Selos "Transcrição automática" e "Texto extraído de imagem (OCR)".
- "Copiar trecho" e "Abrir no Obsidian".
- Documento grande com renderização progressiva.

**Out:**
- Anotações e marcações do usuário.

## Business rules

- BR-1: As relações vêm do frontmatter (`example_of`, `extends`, `related`), em ambos os sentidos: se A é `example_of` B, B mostra A em "Exemplos". O catálogo resolve wikilinks para ids; um link sem alvo no catálogo é omitido.
- BR-2: Selo de transcrição quando o corpo contém "Transcrição automática de áudio"; selo de OCR quando o caminho de origem do ingest indica OCR. Na falta do sinal, o selo não aparece.
- BR-3: No máximo 5 links por grupo, com "ver todos (<n>)" para expandir.

## Functional requirements

- FR-1: Quando o painel abre a partir de uma busca, a web deve destacar com `<mark>` as ocorrências dos termos da pergunta, ignorando acentos e caixa, e rolar até a primeira.
- FR-2: A web deve mostrar "<i> de <n> ocorrências" com botões ▲▼ que movem o foco entre elas.
- FR-3: A API deve devolver em `GET documents/{id}` os grupos de "Veja também" com id, título e facetas de cada alvo (BR-1, BR-3).
- FR-4: Quando o usuário clica num link de "Veja também", o painel deve trocar para o alvo e oferecer "← Voltar" para o anterior.
- FR-5: Quando o usuário clica num chip de Assunto no painel, a conversa deve aplicar esse filtro na busca atual.
- FR-6: "Abrir no Obsidian" deve usar `obsidian://open?vault=<nome>&file=<caminho>`; "Copiar trecho" deve copiar o parágrafo destacado atual e confirmar com "Copiado".
- FR-7: Quando o documento não existe mais, o painel deve mostrar a mensagem de `screens.md` (T3).

## Non-functional requirements

- NFR-1: um documento de 200 KB abre e destaca em ≤ 500 ms numa máquina M-series (medido com Playwright `performance.now`).

## Acceptance criteria

- **AC-1 (FR-1)**
  - Given a pergunta "setupla"
  - When o documento abre
  - Then "Sétupla" fica marcado e visível sem rolar
- **AC-2 (FR-2)**
  - Given 3 ocorrências
  - When o usuário clica em ▼ duas vezes
  - Then o contador mostra "3 de 3"
- **AC-3 (FR-3, BR-1)**
  - Given A `example_of` [[Cabala]]
  - When o artigo Cabala abre
  - Then A aparece em "Exemplos"
- **AC-4 (BR-1, negativo)**
  - Given um `related` para um wikilink inexistente
  - When o painel abre
  - Then o link não aparece
- **AC-5 (BR-3)**
  - Given 8 relacionados
  - When o painel abre
  - Then aparecem 5 e "ver todos (8)"
- **AC-6 (FR-4)**
  - Given o painel no doc A
  - When o usuário abre o relacionado B e clica em "← Voltar"
  - Then o painel volta para A
- **AC-7 (FR-5)**
  - Given o painel com o chip "Cabala"
  - When o usuário clica nele
  - Then a busca da conversa ganha o filtro "Assuntos: Cabala"
- **AC-8 (BR-2)**
  - Given um documento de áudio
  - When ele abre
  - Then aparece o selo "Transcrição automática"
- **AC-9 (FR-6)**
  - Given um trecho destacado
  - When o usuário clica em "Copiar trecho"
  - Then a área de transferência recebe o parágrafo e aparece "Copiado"
- **AC-10 (sem relações)**
  - Given um documento sem relações
  - When ele abre
  - Then a seção "Veja também" não é exibida

## Test strategy

| AC | Nível | Notas |
|---|---|---|
| AC-3, AC-4, AC-5 | Unit (api: catalog relations) | |
| AC-1, AC-2, AC-6–AC-10 | E2E Playwright | vault de fixture com relações |
| NFR-1 | E2E com timing | fixture de 200 KB |

## References

- Screen spec: `docs/design/screens.md` (T3).
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
