---
id: KBC-001
title: Perguntar e abrir um documento (esqueleto andando)
status: done
slice: walking-skeleton
outcome: sessões de pesquisa por semana; % de buscas que abrem documento
depends_on: []
---

# KBC-001 — Perguntar e abrir um documento (esqueleto andando)

## Story

Quando surge uma dúvida de estudo, quero escrever a pergunta numa caixa de chat e abrir o documento encontrado, para estudar a partir da fonte sem usar o terminal.

## Scope

**In:**
- Workspace Nx (pnpm) com `apps/web`, `apps/api` e `libs/contracts`.
- API Fastify com `GET /health`, `GET /api/v1/topics`, `POST /api/v1/topics/{topic}/searches` (sem filtros) e `GET /api/v1/topics/{topic}/documents/{id}` (corpo sem frontmatter).
- Adapter QMD MCP de longa duração, com fallback para o kb CLI.
- Catálogo mínimo, com título e summary.
- Web: tela Início (saudação e caixa de pergunta), seletor "Como buscar" e mensagem de resultados com cartões (título, trecho e facetas em texto).
- Painel do documento (desktop lateral, celular em tela cheia).
- Estados vazio, carregando, erro e sem resultados; script de latência.

**Out:**
- Chips de filtro, agrupamento de cópias (KBC-002).
- Destaque no corpo e "Veja também" (KBC-003).
- IA (KBC-004).
- Lateral, temas extras e seleção de acervo (KBC-005). Neste item o acervo é o primeiro tópico do vault, ou o de `KB_TOPIC`.

## Business rules

- BR-1: os modos de busca são "Tudo" (padrão: lex + vec fundidos, sem expansão por LLM), "Palavras exatas" (lex) e "Por significado" (vec) — ADR 0002.
- BR-2: a API só lê o vault; nenhuma rota escreve em arquivos do vault ou no índice QMD.
- BR-3: um trecho nunca mostra o frontmatter YAML. Se o trecho do QMD cair no frontmatter, mostra-se o `summary` do documento; sem summary, as primeiras linhas do corpo.
- BR-4: um id de documento é o caminho relativo ao tópico; ids que resolvem para fora da pasta do tópico são recusados.

## Functional requirements

- FR-1: Quando o usuário envia uma pergunta não vazia, a web deve mostrar a pergunta como balão e um estado "Buscando no <Acervo>…" em até 400 ms (BR-1).
- FR-2: Quando a busca retorna, a web deve mostrar o resumo "<n> documentos · <modo> · <t> s" e até 10 cartões com título, trecho de até 3 linhas e facetas (tipo de texto, profundidade, ligação com o tema) com nomes em pt-BR (BR-3).
- FR-3: Quando o usuário troca o modo em "Como buscar", a próxima busca deve usar o modo escolhido, e a escolha deve ser lembrada no navegador (BR-1).
- FR-4: Quando o usuário clica num cartão, a web deve abrir o painel do documento com o título, as facetas e o corpo em markdown renderizado sem frontmatter (BR-3).
- FR-5: Quando a busca não encontra nada, a web deve mostrar "Nada encontrado para "<q>"." com a sugestão de trocar para "Por significado" (SL-14).
- FR-6: Quando a API está fora do ar ou o QMD indisponível, a web deve mostrar a mensagem de erro em pt-BR de `screens.md` e o botão "Tentar de novo", preservando a pergunta.
- FR-7: A API deve iniciar um processo `qmd mcp` ao subir e reiniciá-lo com backoff se ele morrer. Se o MCP não iniciar, deve usar `kb search --format json` e reportar `degraded` em `/health`.
- FR-8: A API deve recusar com 404 `DOCUMENT_NOT_FOUND` um id inexistente e com 400 `VALIDATION_FAILED` um id fora do tópico (BR-4).
- FR-9: A API deve escutar só em `127.0.0.1` e recusar requisições com `Host` fora da lista permitida (ADR 0005).

## Non-functional requirements

- NFR-1: busca "Palavras exatas" p95 ≤ 1 s; "Por significado" p95 ≤ 2 s; "Tudo" p95 ≤ 4 s, com a API aquecida. A medida é feita por `pnpm --filter api latency` (20 consultas reais ao tópico hermetismo por modo). Na primeira versão, o resultado é registrado como aviso (QA-16).
- NFR-2: a API sobe com o catálogo de 4.235 documentos carregado em ≤ 5 s.
- NFR-3: a interface segue WCAG 2.2 AA (axe sem violações sérias) em 1440 px e 390 px.

## Acceptance criteria

- **AC-1 (FR-1, FR-2, BR-1)**
  - Given o acervo de fixture com um documento "A Natureza Sétupla"
  - When o usuário escreve "natureza sétupla" e pressiona Enter
  - Then aparece um cartão "A Natureza Sétupla", com o resumo indicando o modo "Tudo"
- **AC-2 (FR-3)**
  - Given o modo "Palavras exatas" escolhido
  - When o usuário recarrega a página e busca
  - Then a requisição usa `mode: exact` e o seletor mostra "Palavras exatas"
- **AC-3 (BR-3)**
  - Given um resultado cujo trecho do QMD é o frontmatter
  - When a lista é exibida
  - Then o cartão mostra o summary, e não `title:`/`type:`
- **AC-4 (FR-4)**
  - Given resultados na tela
  - When o usuário clica num cartão
  - Then o painel abre com o título e o corpo sem frontmatter
  - And Esc fecha o painel
- **AC-5 (FR-5)**
  - Given uma pergunta sem correspondência
  - When a busca termina
  - Then aparece o estado sem resultados com o botão "Buscar por significado"
- **AC-6 (FR-6)**
  - Given a API respondendo 503 `SEARCH_UNAVAILABLE`
  - When o usuário busca
  - Then aparece a mensagem de erro e "Tentar de novo"
  - And a pergunta continua no balão
- **AC-7 (FR-8, BR-4, negativo)**
  - Given o id `../../../etc/passwd`
  - When a API recebe `GET documents/{id}`
  - Then responde 400 `VALIDATION_FAILED` sem ler o arquivo
- **AC-8 (FR-9, negativo)**
  - Given uma requisição com `Host: evil.example`
  - When ela chega à API
  - Then a API responde 403
- **AC-9 (FR-7)**
  - Given um binário QMD que falha ao iniciar
  - When a API sobe
  - Then `/health` reporta `search: degraded` e a busca usa o kb CLI
- **AC-10 (BR-2)**
  - Given qualquer sequência de chamadas da API
  - When os testes de integração terminam
  - Then o hash da pasta do vault de fixture é o mesmo de antes
- **AC-11 (NFR-3)**
  - Given as telas Início, resultados e painel
  - When o axe roda em 1440 px e 390 px
  - Then não há violações "serious" ou "critical"

## Test strategy

| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-4, AC-5, AC-6, AC-11 | E2E Playwright | API real com vault de fixture (`apps/api/test/fixtures/vault`) e um índice de busca stub via `SearchIndexPort` fake injetado por env `KB_CHAT_SEARCH=fixture` |
| AC-3 | Unit (api, search) | snippet cleaner |
| AC-7, AC-8, AC-10 | Integração (api, `fastify.inject`) | |
| AC-9 | Integração | `QMD_BIN` apontando para um script que sai com 1 |
| NFR-1 | Script de latência (manual/local) | registrado na validação local |

## References

- Screen spec: `docs/design/screens.md` (T1, T2, T3).
- Architecture: `docs/architecture/overview.md`; ADRs 0001, 0002 e 0005.
- Contracts: `libs/contracts`.

## Open questions

Nenhuma.

## Definition of ready

- [x] Story, scope e outcome
- [x] BR/FR cobertos por AC, com negativos
- [x] NFRs mensuráveis
- [x] Nível de teste por AC
- [x] Referências de UI e arquitetura
- [x] Sem dependências nem perguntas abertas
- [x] Cabe num goal (grande, mas é o esqueleto; os filtros e a IA foram separados)
