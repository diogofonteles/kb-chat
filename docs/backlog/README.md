# Backlog — kb-chat

Resultado perseguido (`docs/product/brief.md`): o dono pesquisa o acervo pelo navegador **≥ 3 sessões/semana**; **≥ 50%** das buscas abrem um documento; gasto de IA ≤ US$ 1/dia.

## Story map

| Atividade → | Perguntar | Refinar | Ler | Obter síntese | Organizar a sessão |
|---|---|---|---|---|---|
| **Esqueleto andando** | Caixa de pergunta + 3 modos (KBC-001) | — (stub: sem filtros) | Painel com o corpo do documento (KBC-001) | — (stub: botão ausente) | Acervo fixo por env (KBC-001) |
| **Release 1** | Sugestões de assunto no início (KBC-006) | Chips com contagens, cópias agrupadas, "Fora do tema" oculto (KBC-002) | Destaque do trecho, resumo, "Veja também", selos OCR/áudio (KBC-003) | Responder com IA: custo, citações, teto (KBC-004) | Seletor de acervo, histórico da sessão, temas, gasto do dia (KBC-005); log de uso (KBC-006) |
| **Release 2** | Autocomplete | Ordenação, data | Anotações | Conversa multi-turno, "resposta profunda" com kb find | Login de convidados, teto por pessoa, hospedagem |

O esqueleto atravessa todos os componentes: SPA → API → QMD MCP → vault → painel.

## Itens (ordem de execução)

| ID | Título | Fatia | Status | Depende de |
|---|---|---|---|---|
| [KBC-001](KBC-001-walking-skeleton-search-and-read.md) | Perguntar e abrir um documento (esqueleto) | walking-skeleton | done | — |
| [KBC-002](KBC-002-filter-chips-and-grouped-results.md) | Filtrar resultados por facetas com contagens | release-1 | done | KBC-001 |
| [KBC-003](KBC-003-document-panel-highlight-and-see-also.md) | Ler com trecho destacado e "Veja também" | release-1 | done | KBC-001 |
| [KBC-004](KBC-004-grounded-ai-answer.md) | Responder com IA citando as fontes | release-1 | done | KBC-001 |
| [KBC-005](KBC-005-sidebar-topics-history-themes.md) | Lateral: acervo, histórico, temas e gasto | release-1 | done | KBC-001, KBC-004 |
| [KBC-006](KBC-006-start-suggestions-and-usage-log.md) | Sugestões iniciais e log de uso local | release-1 | in-progress | KBC-002 |
| [KBC-007](KBC-007-onboarding-preferences-ai-provider.md) | Onboarding: preferências e provedor de IA (chave própria ou assinatura Claude/ChatGPT) | release-1 | ready | KBC-004, KBC-005 |

## Definição de pronto (global)

- Gates verdes: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check` (cobertura ≥ 80% em linhas por projeto).
- E2E Playwright do fluxo tocado (API real com vault de fixture, LLM stub).
- Telas validadas em 1440 px e 390 px contra `docs/design/screens.md`; WCAG 2.2 AA (axe sem violações sérias).
- Textos de UI em pt-BR externalizados; nenhum termo interno do kb na tela.
- A API nunca escreve no vault; nenhum segredo em log ou resposta.

## Decisões de escopo

- 2026-10-24: o dono autorizou seguir sem perguntas até a primeira versão publicada; revisa depois. Os padrões do kickoff valem como decisões.
- "Publicação" da release 1 = merge em `develop` no GitHub privado `diogofonteles/kb-chat` e app rodando localmente (`pnpm dev`). A promoção para `main` é decisão do dono.
