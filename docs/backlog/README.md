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
| [KBC-031](KBC-031-subscription-reasons-and-lending-at-invite.md) | Assinatura do ChatGPT escolhível em produção (motivos corretos do cartão, "Testar conexão" pelo executor) e cessão de assinaturas no convite com a confirmação dos termos | release-1 | in-review | KBC-024, KBC-027, KBC-028 |
| [KBC-030](KBC-030-guaranteed-exhaustive-sweep.md) | Exaustivo garantido: o aplicativo planeja (ou usa o plano padrão), varre o conjunto inteiro em lotes em todos os provedores, mede a cobertura, mostra estimativa e progresso, e "Continuar varredura" retoma de onde parou | release-1 | in-review | KBC-017, KBC-018, KBC-020, KBC-022 |
| [KBC-032](KBC-032-public-tutorial.md) | Tutorial público com imagens: como usar cada funcionalidade, aberto sem login | release-1 | in-review | KBC-016, KBC-029, KBC-030, KBC-031 |
| [KBC-033](KBC-033-default-collection-hint.md) | Acervo padrão no editor de convite e de perfil: dica quando nenhum acervo está marcado, pré-seleção do único marcado e aviso quando o padrão é limpo | release-1 | in-review | KBC-028 |
| [KBC-009](KBC-009-build-and-grow-a-collection.md) | Montar ou ampliar um acervo (arquivos locais e web, contas Firecrawl/OpenRouter com saldos) | release-2 | draft | KBC-007 |

### Fase 2 — acervo de mídia, fase A (do envio ao player com legenda e à busca)

Plano completo (fases A a E, custos e riscos): plano da fase 2 v3, publicado pelo dono; piloto em [`docs/research/2026-10-28-transcription-pilot.md`](../research/2026-10-28-transcription-pilot.md); ADRs [0022](../adr/0022-media-library-store-queue-and-streaming.md), [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) e [0024](../adr/0024-media-search-outside-the-vault.md).

| Atividade → | Enviar | Converter e guardar | Transcrever | Ouvir e ler | Achar |
|---|---|---|---|---|---|
| **Esqueleto (KBC-034)** | Um áudio por vez, até 500 MB | Fila confiável, AAC no worker com CPU limitada | — (stub: sem texto) | Player próprio com os controles básicos e Range | Lista "Mídia" do acervo |
| **Fase A** | Retomável, vídeo, cota, repetidos (KBC-035) | — | Mac do dono (KBC-036), termos editáveis (KBC-040), Groq de reserva (KBC-037) | Player completo: velocidade, teclado, tela de bloqueio, retomar, mini-player (KBC-041); pulos configuráveis (KBC-043), timer para dormir (KBC-046), encurtar silêncios (KBC-044), marcadores com nota (KBC-042); legendas e transcrição clicável (KBC-038), palavra a palavra (KBC-045) | "Na fala" na busca, no minuto exato (KBC-039) |
| **Biblioteca (pedido de 2026-10-29)** | — | — | — | Fila "A seguir", anterior/próxima, aleatório, repetir e continuar com a próxima (KBC-053); baixar para ouvir offline (KBC-056) e listas baixadas em dia (KBC-057) | Biblioteca só de mídia com continuar, recentes, filtros e marcar como ouvida (KBC-051); Favoritas (KBC-052); playlists (KBC-054), pastas e fixar (KBC-055), compartilhar com pessoas do app (KBC-058); página do autor (KBC-059) |
| **Fases B a E** | Importação em lote | Faixas e capítulos | Classificação | Compilados | Sinônimos, pesquisa com IA, coleções, compartilhamento, busca na web |

| ID | Título | Fatia | Status | Depende de |
|---|---|---|---|---|
| [KBC-034](KBC-034-media-walking-skeleton-upload-and-play.md) | Mídia (esqueleto): enviar um áudio, converter numa fila confiável e ouvir no navegador | phase-2-a | done | KBC-010, KBC-012 |
| [KBC-041](KBC-041-full-player-controls-resume-and-mini-player.md) | Player completo: velocidade, volume, atalhos de teclado, controles do sistema, retomar de onde parou e mini-player | phase-2-a | done | KBC-034 |
| [KBC-043](KBC-043-configurable-skip-intervals.md) | Intervalos de pulo configuráveis | phase-2-a | done | KBC-041 |
| [KBC-046](KBC-046-sleep-timer.md) | Timer para dormir | phase-2-a | done | KBC-041 |
| [KBC-042](KBC-042-bookmarks-with-notes.md) | Marcadores com nota | phase-2-a | done | KBC-041 |
| [KBC-060](KBC-060-masters-act-as-a-person.md) | Ver como outra pessoa (master, com auditoria) | phase-2-a | ready | KBC-010 |
| [KBC-048](KBC-048-collections-and-sub-collections.md) | Acervos e sub-acervos pela tela | phase-2-a | ready | KBC-034 |
| [KBC-050](KBC-050-edit-media-details.md) | Editar as informações de um áudio: título, autoria e acervo | phase-2-a | ready | KBC-034 |
| [KBC-036](KBC-036-transcription-on-the-mac-worker.md) | Transcrição no Mac do dono: transcritor pareado, VAD e termos, JSON bruto, filtro de repetições, baixa confiança | phase-2-a | ready | KBC-034 |
| [KBC-038](KBC-038-player-subtitles-clickable-transcript.md) | Player com legendas e transcrição clicável | phase-2-a | ready | KBC-036, KBC-041 |
| [KBC-039](KBC-039-media-in-search-exact-minute.md) | Mídia na busca, no minuto exato | phase-2-a | ready | KBC-036, KBC-038 |
| [KBC-049](KBC-049-authors-per-collection.md) | Autores livres por acervo, com autor principal | phase-2-a | ready | KBC-048 |
| [KBC-044](KBC-044-skip-silences.md) | Encurtar silêncios (mapa de silêncios no worker) | phase-2-a | ready | KBC-041 |
| [KBC-045](KBC-045-word-by-word-highlight.md) | Destaque palavra a palavra | phase-2-a | ready | KBC-038 |
| [KBC-040](KBC-040-editable-term-list-and-retranscribe.md) | Lista de termos editável e "Transcrever de novo" | phase-2-a | ready | KBC-036 |
| [KBC-035](KBC-035-resumable-upload-quotas-video-duplicates.md) | Envio retomável, vídeo 720p, cota por pessoa e arquivos repetidos | phase-2-a | ready | KBC-034 |
| [KBC-037](KBC-037-groq-transcription-fallback.md) | Groq como reserva da transcrição, com teto mensal | phase-2-a | ready | KBC-036 |
| [KBC-047](KBC-047-people-groups-with-permissions.md) | Grupos de pessoas com permissões e acervos | backlog | draft | KBC-028 |
| [KBC-051](KBC-051-media-library-home.md) | Biblioteca de mídia: continuar ouvindo, ouvidas recentemente, filtros, ordenação, grade ou lista e marcar como ouvida (`media-library`) | phase-2-library | ready | KBC-041 |
| [KBC-052](KBC-052-media-favorites.md) | Favoritas (`media-favorites`) | phase-2-library | ready | KBC-051 |
| [KBC-053](KBC-053-play-queue-shuffle-repeat.md) | Fila "A seguir", anterior/próxima, aleatório, repetir e continuar com a próxima (`media-queue`) | phase-2-library | ready | KBC-051 |
| [KBC-054](KBC-054-playlists.md) | Playlists (`media-playlists`) | phase-2-library | ready | KBC-051, KBC-053 |
| [KBC-055](KBC-055-playlist-folders-and-pins.md) | Pastas de playlists, ordem própria e fixar no topo (`media-library-organize`) | phase-2-library | ready | KBC-054 |
| [KBC-056](KBC-056-offline-downloads.md) | Baixar para ouvir offline: service worker, download retomável, tocar sem rede com legenda, Baixadas, licenças que expiram (`media-offline`, ADR 0026) | phase-2-library | ready | KBC-051, KBC-035 |
| [KBC-057](KBC-057-offline-lists-and-sync.md) | Offline de playlists e Favoritas, sincronização e ações feitas sem rede (`media-offline-lists`) | phase-2-library | ready | KBC-056, KBC-054, KBC-052, KBC-042 |
| [KBC-058](KBC-058-share-playlists-with-app-users.md) | Compartilhar playlists com pessoas do app, "pode ouvir" ou "pode editar" (`media-playlist-sharing`) | phase-2-library | ready | KBC-054 |
| [KBC-059](KBC-059-author-pages.md) | Página do autor na Biblioteca (`media-authors`) | phase-2-library | ready | KBC-051, KBC-049 |

## Definição de pronto (global)

- Gates verdes: `pnpm lint && pnpm typecheck && pnpm test && pnpm build && pnpm format:check` (cobertura ≥ 80% em linhas por projeto).
- E2E Playwright do fluxo tocado (API real com vault de fixture, LLM stub).
- Telas validadas em 1440 px e 390 px contra `docs/design/screens.md`; WCAG 2.2 AA (axe sem violações sérias).
- Textos de UI em pt-BR externalizados; nenhum termo interno do kb na tela.
- A API nunca escreve no vault; nenhum segredo em log ou resposta.
- **Toda funcionalidade nova tem permissão própria** (regra do dono, 2026-10-28): é liberada por pessoa (ou por grupo, com os perfis de convite e a aplicação em lote em "Pessoas e permissões"), nunca liga para todos sozinha; masters têm todas; o item diz qual permissão cria e a tela de pessoas a mostra.

### Barra de qualidade da fase 2 (vale para KBC-034 a KBC-041, além da definição global)

Pedido do dono (2026-10-28): código, infraestrutura e UI/UX de qualidade máxima; o player moderno, completo e sem bugs; testes criteriosos.

- **Cobertura:** ≥ 90% de linhas e de ramos no código novo de mídia (módulo `media` da API, `features/media` do web, worker), com limite por pasta na configuração do Vitest, para não esconder buraco na média do projeto.
- **Mutação:** Stryker nos núcleos de lógica pura (fila, leitura de Range, gerador de WebVTT, filtro de repetições, máquina de estados do player, mapa de atalhos), com nota ≥ 80%. Roda no item (não no CI) e o resultado entra no `qa.md`.
- **Propriedades:** fast-check onde a entrada é um espaço grande: cabeçalho Range, limites dos cues do WebVTT, filtro de repetições, formatação de tempo.
- **E2E de mídia de verdade:** áudios reais gerados por ffmpeg no setup do teste; as asserções conferem a reprodução (o `currentTime` anda, o pulo chega ao segundo certo), não só o DOM. Os specs de mídia rodam no **Google Chrome** (o Chromium do Playwright não decodifica AAC nem H.264) em 1440 px e 390 px e no **WebKit** (motor do Safari). Se o WebKit do Linux não tocar AAC no CI, ele roda no Mac antes da PR e o resultado entra no `qa.md`.
- **Estabilidade:** nenhuma espera fixa (`waitForTimeout`), só por condição; os specs de mídia passam 3 vezes seguidas (`--repeat-each=3`) antes da PR; nenhum teste desligado ou asserção afrouxada.
- **UI:** cada estado das telas T14 e T15 capturado nos três temas e nas duas larguras e conferido contra `docs/design/screens.md` na validação local; o review de toda PR com tela inclui o do `product-designer`; axe sem violações sérias ou críticas nos três temas.
- **Infraestrutura:** contêiner novo com limite de CPU e memória, healthcheck, usuário sem root, sistema de arquivos só leitura onde der e logs sem segredo; migração e rollback testados no Mac (staging) antes da produção.
- **Aparelhos reais (antes da produção):** o dono confere no iPhone (Safari) e num Android (Chrome) a tela de bloqueio, os botões do fone, a reprodução em segundo plano e o retomar. A mídia só liga em produção (`KB_CHAT_MEDIA=on`) depois do KBC-041.

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
- 2026-10-27: em produção, um modelo gratuito no Exaustivo leu 38 de 2.555 documentos e escreveu uma cobertura falsa. O dono decidiu que, no Exaustivo, o aplicativo garante a varredura para todo provedor e mede a cobertura (KBC-030, ADR 0021); os sub-pesquisadores do KBC-018 saem do Exaustivo.
- 2026-10-27: o dono pediu uma página de tutorial com imagens, aberta sem login (KBC-032), com todas as funcionalidades; as capturas são geradas por script contra o servidor E2E.
- 2026-10-27 (relato do dono em produção): o "Acervo padrão" do convite parecia quebrado com nenhum acervo marcado. Entra o KBC-033: dica sob o campo, pré-seleção do único acervo marcado e aviso quando o padrão é limpo.
- 2026-10-27 (pedido do dono): fase 2, acervo de áudio e vídeo. Volume ainda desconhecido (planejado com 500 h e 2.000 h), maioria áudio de palestras, compartilhamento só entre usuários do app, custo conforme a proposta. Da Paneas, só conhecimento (sem código, servidores ou contas da empresa).
- 2026-10-28 (piloto e decisões do dono, plano v3): transcrever no Mac do dono, com o Groq de reserva (ADR 0023); gravações ruidosas pesquisáveis com aviso de baixa confiança; teto mensal de gasto da mídia de US$ 10; originais não guardados por padrão (só os insubstituíveis, em arquivo frio, depois); ordem das fases piloto → A → B → C → D → E. Transcrições indexadas fora do vault (ADR 0024). Fase A = KBC-034 a KBC-040, na ordem da tabela acima.
- 2026-10-28 (pedido do dono, "tudo de extrema qualidade; o player precisa ser muito bom, sem bug e com UI/UX moderna; testes criteriosos"): entram as telas T14 e T15 em `docs/design/screens.md`, a barra de qualidade da fase 2 acima e o KBC-041 (player completo), logo depois do KBC-034. O KBC-034 troca o player nativo pelo player próprio com os controles básicos e ganha "Remover" para masters; a velocidade sai do KBC-038 para o KBC-041. Fase A = KBC-034, KBC-041, KBC-036, KBC-038, KBC-039, KBC-040, KBC-035 e KBC-037.
- 2026-10-28 (regra do dono: "essa feature, assim como todas as outras que iremos desenvolver, devem ser liberadas por usuário (ou grupo de usuários)"): o KBC-034 ganha a permissão `media` ("Ouvir mídia"), além de `media-upload` ("Enviar áudios"); a regra entra na definição de pronto. Grupos de verdade (mudar o grupo muda todos os membros) viram o KBC-047, a decidir.
- 2026-11-03 (pedido do dono): o master pode usar o app como qualquer outra pessoa, para ver o que ela vê, ajustar as configurações dela e reproduzir os bugs que ela relata (KBC-060, ADR 0027, que altera a 0008); entra como o próximo item, logo depois do KBC-042.
- 2026-10-29 (pedido do dono, prioridade): criar acervos e sub-acervos pela tela, com permissão própria que pode ser dada a quem envia conteúdo (KBC-048), e informar o autor de cada conteúdo, com autores por acervo (KBC-049). Entram logo depois do KBC-042, antes do restante da fase A. Na mesma data o dono pôs a transcrição logo depois do KBC-048 e pediu editar as informações de um áudio (KBC-050), que entra junto dos acervos; a ordem da fase A passa a ser: KBC-042, KBC-048, KBC-050, KBC-036, KBC-038, KBC-039, KBC-049, KBC-044, KBC-045, KBC-040, KBC-035, KBC-037. Ainda em 2026-10-29 o dono pediu a mídia integrada à busca com o alcance escolhido (textos, áudios, vídeos) e as referências de mídia abrindo o player no ponto: entra no KBC-039, que passa a vir logo depois do KBC-038. Os acervos `udv` ("UDV") e `udv/palavra-do-mestre` ("Palavra do Mestre") foram criados à mão no vault nesse dia.
- 2026-10-28 (decisão do dono, "vamos implementar todos os recursos"; "esse player servirá também para os vídeos"): entram na fase A os marcadores com nota (KBC-042), os pulos configuráveis (KBC-043), encurtar silêncios por mapa calculado no worker (KBC-044), o destaque palavra a palavra (KBC-045) e o timer para dormir (KBC-046). O player é próprio e em camadas que servem áudio e vídeo (ADR 0025); o KBC-035 só acrescenta a visão de vídeo. Ordem da fase A: KBC-034, KBC-041, KBC-043, KBC-046, KBC-042, KBC-044, KBC-036, KBC-038, KBC-045, KBC-039, KBC-040, KBC-035, KBC-037. Marcadores são privados de cada pessoa até a fase D (compartilhamento).
- 2026-10-29 (pedido do dono: "no caso dos audios e videos, deveremos ter uma interface como uma biblioteca de audio e video (vamos usar como modelo o spotfy) para navegarmos apenas naquela midia, poder criar playlists, salvar como favorito, salvar pra ouvir offline (pegue as features que temos no spotfy para que tenhamos tambem em nosso player), no caso teremos até mais coisas que o spotfy pois teremos a legenda em tempo real"; "isso deve valer para audio e video"): benchmark em [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md) (o que fica, o que se adapta e o que sai do Spotify: recomendações, social, anúncios e Jam saem). Entram os KBC-051 a KBC-059 (Biblioteca, Favoritas, fila, playlists, pastas e fixar, offline, offline de listas, compartilhar playlists, página do autor), telas T16 a T19 e a ADR [0026](../adr/0026-offline-media-downloads.md) (proposta) para o offline. Cada item cria a própria permissão e vale para áudio e vídeo. A ordem na fila de execução fica para o dono decidir; os itens entram no fim da tabela.
- "Publicação" da release 1 = merge em `develop` no GitHub privado `diogofonteles/kb-chat` e app rodando localmente (`pnpm dev`). A promoção para `main` é decisão do dono.
