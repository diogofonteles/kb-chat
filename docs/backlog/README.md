# Backlog — Nova Alexandria (`kb-chat`)

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
| [KBC-010](KBC-010-google-login-and-permissions.md) | Login com conta Google e acesso por permissões (funcionalidades e acervos) | release-1 | done | KBC-007, KBC-008 |
| [KBC-012](KBC-012-deploy-oracle-cloud.md) | Publicar em produção na Oracle Cloud (Always Free): VM ARM, Compose, Caddy com HTTPS, deploy por merge em `main`, backup criptografado | release-1 | in-review | KBC-010 |
| [KBC-014](KBC-014-access-requests-and-code-sign-in.md) | Solicitar acesso, cadastro sem Google e entrada com código por e-mail ou SMS | release-1 | in-review | KBC-010 |
| [KBC-015](KBC-015-gmail-smtp-email-delivery.md) | Enviar os e-mails de código e de aprovação pelo SMTP do Gmail (produção 100% gratuita) | release-1 | done | KBC-014 |
| [KBC-016](KBC-016-rename-product-nova-alexandria.md) | Dar ao produto o nome "Nova Alexandria" em todo texto que a pessoa vê | release-1 | done | KBC-014, KBC-015 |
| [KBC-017](KBC-017-exhaustive-research.md) | Pesquisa exaustiva: busca literal sem teto (modos, páginas, filtros por autor e origem), leitura de livros inteiros e o perfil "Exaustivo" com compactação | release-1 | done | KBC-008, KBC-011 |
| [KBC-018](KBC-018-research-subagents.md) | Pesquisa exaustiva com sub-pesquisadores em paralelo (orquestrador e trabalhadores, contexto próprio, citações na resposta, progresso agrupado) | release-1 | done | KBC-017 |
| [KBC-020](KBC-020-authorship-mestre-laercio-and-other-authors.md) | Autoria: Mestre Laércio × outros autores (filtro e selos na busca, fontes agrupadas, ferramentas e prompt da IA que nunca misturam os dois) | release-1 | done | KBC-002, KBC-003, KBC-017 |
| [KBC-026](KBC-026-invitation-email.md) | E-mail de convite: enviar ao convidar (com opção de não enviar), status "Convite enviado em …" / "Ativo" na lista e "Reenviar convite" com limite | release-1 | done | KBC-010, KBC-014, KBC-015 |
| [KBC-022](KBC-022-house-ai-plan.md) | Plano da casa: a IA gratuita da aplicação, configurada pelo master na tela (OpenRouter por OAuth, modelos gratuitos ao vivo, cota diária por pessoa, política de acesso à IA por pessoa, chaves cifradas, produção sem chave no .env) | release-1 | done | KBC-007, KBC-010, KBC-017 |
| [KBC-023](KBC-023-own-ai-guided-setup.md) | Sua IA: cada pessoa traz a própria IA com um guia na tela (OpenRouter em um clique com modelos gratuitos, Gemini gratuito, Claude e OpenAI por chave de API, cartão "Quem atende você agora") | release-1 | done | KBC-007, KBC-022 |
| [KBC-024](KBC-024-lend-owner-claude-subscription.md) | Assinatura do Claude do dono cedida a pessoas específicas (só o dono cede, confirmação dos termos, nunca padrão, cota diária, aviso à pessoa, auditoria) | release-1 | done | KBC-007, KBC-022, KBC-023 |
| [KBC-027](KBC-027-sandboxed-codex-subscription.md) | Assinatura do ChatGPT (Codex) como IA da aplicação, com sandbox obrigatório (contêiner separado e executor, liga/desliga do master, cessão como a do Claude, prova em CI) | release-1 | done | KBC-007, KBC-022, KBC-024 |
| [KBC-028](KBC-028-preconfigured-invitation.md) | Convite pré-configurado: IA, permissões e preferências no convite, perfis de convite ("Aluno", "Pesquisador") com um padrão, "Aplicar perfil" a pessoas existentes | release-1 | in-review | KBC-010, KBC-022, KBC-026 |
| [KBC-029](KBC-029-history-on-submit.md) | A conversa aparece no histórico assim que a pergunta é enviada (turno pendente gravado pelo servidor, pesquisa que segue após recarregar, "pesquisando…", "interrompida", "falhou") | release-1 | in-review | KBC-005, KBC-008, KBC-011 |
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
- 2026-10-24 (pedido do dono): a produção vai para uma VM Always Free da OCI (KBC-012, ADR 0010). Só produção fica hospedada; o Mac do dono é o staging. Tudo pronto para rodar; a conta OCI, o domínio e os logins são do dono.
- 2026-10-25: o dono pediu que ninguém entre sem aprovação, com cadastro sem Google e entrada por código (KBC-014, ADR 0011). O SMS sai desligado até o dono escolher um provedor (nenhum é gratuito no Brasil).
- 2026-10-25: o dono quer a produção 100% gratuita e não vai comprar domínio. Os e-mails saem pelo SMTP do Gmail com senha de app (KBC-015, ADR 0012) e o site roda num subdomínio do DuckDNS; o Resend fica como alternativa para quando houver domínio.
- 2026-10-25: o dono deu ao produto o nome **Nova Alexandria** (KBC-016). Muda todo texto que a pessoa vê (site, e-mails, docs para o usuário); repositório, pacotes, variáveis e identificadores internos continuam `kb-chat`.
- 2026-10-25: o dono quer a pesquisa com IA "sem limitações" e espelhada no Claude (Grep, Read, compactação, sub-agentes). Entra o KBC-017 (ferramentas, filtros, paginação, perfil Exaustivo, ADR 0013) e, em seguida, o KBC-018 (sub-agentes); divisão confirmada pelo dono.
- 2026-10-26: o dono exige separar com clareza a obra de José Laércio do Egito (Mestre Laércio) dos livros de outros autores. O vault marca cada fonte com `author_group`; entra o KBC-020 (ADR 0015) na busca, nas fontes e na pesquisa com IA.
- 2026-10-26: o dono pediu que o convite de um master envie e-mail ao convidado, com status na lista e reenvio limitado (KBC-026). Antes, o convite só liberava o acesso.
- 2026-10-26: o dono decidiu que "nada deve ser configurado por nós via código; tudo pela UI do usuário", com custo muito baixo e transparente e poucos convidados. Entram o KBC-022 (plano da casa e política de acesso à IA por pessoa, ADR 0016), o KBC-023 (cada pessoa traz a própria IA, com guia na tela) e o KBC-024 (a assinatura do Claude do dono cedida por pessoa). No mesmo dia: o master escolhe, por pessoa, qual IA da aplicação a atende (plano da casa, assinatura do Claude, nenhuma) e pode conceder a uma, várias ou todas; a IA própria da pessoa vence, salvo se o master marcar "Usar sempre a IA da aplicação".
- 2026-10-27 (pedido do dono): "quando eu escreva uma pergunta e ela inicie a busca, aquela conversa já apareça no histórico". Entra o KBC-029: a pergunta é gravada no envio, o turno da pesquisa com IA roda no servidor até o fim mesmo se a página recarregar ou fechar (só "Parar" para) e o histórico mostra "pesquisando…", "interrompida" ou "falhou".
- "Publicação" da release 1 = merge em `develop` no GitHub privado `diogofonteles/kb-chat` e app rodando localmente (`pnpm dev`). A promoção para `main` é decisão do dono.
