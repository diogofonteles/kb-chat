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
| [KBC-006](KBC-006-start-suggestions-and-usage-log.md) | Sugestões iniciais e log de uso local | release-1 | done | KBC-002 |
| [KBC-008](KBC-008-conversational-research-agent.md) | IA que pesquisa o acervo e conversa com contexto | release-1 | done | KBC-004, KBC-005 |
| [KBC-007](KBC-007-onboarding-preferences-ai-provider.md) | Configurações sempre à mão, onboarding e provedor de IA (chave própria ou assinatura Claude/ChatGPT) | release-1 | done | KBC-005, KBC-008 |
| [KBC-011](KBC-011-faster-research.md) | Pesquisa mais rápida: perfis Rápido/Profundo, modelo por perfil, aprofundamento automático e resposta que aparece assim que começa | release-1 | in-review | KBC-008 |
| [KBC-010](KBC-010-google-login-and-permissions.md) | Login com conta Google e acesso por permissões (funcionalidades e acervos) | release-1 | draft | KBC-007, KBC-008 |
| [KBC-009](KBC-009-build-and-grow-a-collection.md) | Montar ou ampliar um acervo (arquivos locais e web, contas Firecrawl/OpenRouter com saldos) | release-2 | draft | KBC-007 |

## Definição de pronto (global)

- Gates verdes: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check` (cobertura ≥ 80% em linhas por projeto).
- E2E Playwright do fluxo tocado (API real com vault de fixture, LLM stub).
- Telas validadas em 1440 px e 390 px contra `docs/design/screens.md`; WCAG 2.2 AA (axe sem violações sérias).
- Textos de UI em pt-BR externalizados; nenhum termo interno do kb na tela.
- A API nunca escreve no vault; nenhum segredo em log ou resposta.

## Decisões de escopo

- 2026-10-24: o dono autorizou seguir sem perguntas até a primeira versão publicada; revisa depois. Os padrões do kickoff valem como decisões.
- 2026-10-24 (revisão do dono): a "Responder com IA" de uma chamada (ADR 0004) não atinge o objetivo. Entra o KBC-008 (agente de pesquisa conversacional, ADR 0006) antes do KBC-007, e a conversa multi-turno sai da release 2 para a release 1. O KBC-007 ganha "Configurações" sempre acessível e a assinatura do Claude rodando o mesmo agente via MCP.
- 2026-10-24 (pedido do dono, "manter 100% do histórico"): o histórico sai do `localStorage` (50 conversas) e passa a ser guardado sem limite pela API local, com as conversas de busca e de pesquisa com IA. Emendas no KBC-005 (BR-1, AC-3, AC-4) e no KBC-008 (FR-1: rota `POST /api/v1/topics/:topic/research`, sem `mode`).
- 2026-10-24 (teste do dono, "achei um pouco demorado na resposta"): entra o KBC-011. O Sonnet passa a ser o modelo padrão da assinatura do Claude (configurável), a pesquisa ganha os perfis Rápido e Profundo e a resposta aparece assim que começa (ADR 0009).
- 2026-10-24: o dono tornou requisito o login com conta Google e o acesso a funcionalidades e acervos por permissão (KBC-010, ADR 0008). Entra antes do KBC-009 e substitui o "usuário único local" da ADR 0005.
- "Publicação" da release 1 = merge em `develop` no GitHub privado `diogofonteles/kb-chat` e app rodando localmente (`pnpm dev`). A promoção para `main` é decisão do dono.
