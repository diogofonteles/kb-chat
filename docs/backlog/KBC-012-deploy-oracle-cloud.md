---
id: KBC-012
title: Publicar o kb-chat em produção na Oracle Cloud (Always Free)
status: in-review
slice: release-1
outcome: o dono e os convidados usam o kb-chat de qualquer lugar, por HTTPS, sem custo de infraestrutura
depends_on: [KBC-010]
---

# KBC-012 — Publicar o kb-chat em produção na Oracle Cloud (Always Free)

## Story
Como dono do acervo, quero o kb-chat publicado num endereço HTTPS meu, com login Google, para pesquisar fora do Mac e liberar o acesso a convidados. O app e o acervo ficam numa máquina que não custa nada, e um merge em `main` publica a versão sozinho.

Pedido de 2026-10-24: "Prepare a produção na Oracle Cloud Infrastructure (OCI) Always Free". Ainda não há conta OCI nem CLI. Tudo fica pronto para rodar (scripts e documentação); nenhum recurso de nuvem é criado neste item.

## Scope
**In:**
- **Uma VM ARM `VM.Standard.A1.Flex`** com Ubuntu 24.04 aarch64, provisionada por `deploy/oci/provision.sh` (dry-run por padrão, idempotente) e configurada por `deploy/cloud-init.yaml`. O tamanho é **2 OCPU e 12 GB**, o limite Always Free desde junho de 2026: o pedido citava 4/24, o limite anterior.
- **Docker Compose** (`deploy/compose.yml`) com dois serviços:
  - `web`: Caddy com HTTPS automático, o SPA, CSP e cabeçalhos de segurança, `/api` e `/health` para a API, `/mcp` fechado;
  - `api`: Node 22 com `qmd`, `kb` e `claude`, sem porta publicada.
- **Ambientes:**
  - só **produção** fica hospedada (branch `main`);
  - o "staging" é o Mac do dono: `pnpm dev`, o E2E e as mesmas imagens com `docker compose` em `localhost`;
  - a justificativa está na ADR 0010.
- **Acervo e índice QMD** vão do Mac para a VM por `rsync` sobre SSH (`deploy/scripts/sync-vault.sh`), **nunca pelo GitHub**. O script tem dry-run, recusa acervo vazio e limita as remoções.
- **Estado** (conversas, configurações, pessoas, sessões, login do Claude) fica num block volume em `/srv/kb-chat`, com:
  - backup diário criptografado (`age`) no Object Storage;
  - retenção de 30 dias;
  - restauração documentada.
- **Deploy por GitHub Actions** em push para `main`, em quatro passos:
  1. imagens arm64 no GHCR com a tag do SHA;
  2. SSH com chave de comando forçado;
  3. `docker compose pull && up -d`, com a execução casada pelo SHA;
  4. smoke de `/health` e da página de login, com rollback automático para a versão anterior.
- **Segurança:**
  - SSH só por chave, fail2ban e unattended-upgrades;
  - portas 22/80/443 apenas;
  - `ALLOWED_HOSTS` e `WEB_ORIGIN` do domínio;
  - segredos só no `.env` do servidor (root, 0600), nunca no git.
- **Assinatura do Claude no servidor:** só do dono (BR-5 do KBC-010). O dono faz `claude /login` uma vez, por SSH. As restrições dos termos estão na ADR 0010.
- **Mitigação da recuperação de VM ociosa** e **guarda de custo** (orçamento de US$ 1 com alerta).
- Ajustes mínimos na API para rodar atrás do proxy:
  - `HOST`;
  - `TRUST_PROXY`;
  - MCP só por loopback;
  - varredura das sessões expiradas na VM.

**Out:**
- Criar a conta OCI, o domínio, o DNS ou o cliente OAuth (ações do dono, abaixo).
- Um segundo ambiente hospedado (staging na nuvem), alta disponibilidade, mais de uma instância.
- Gerar o índice QMD na VM (os embeddings continuam no Mac).
- Monitoramento externo pago; observabilidade além de logs, healthcheck e smoke.

## Business rules
- BR-1: a produção só muda por merge em `main`, decisão do dono. Nenhum agente promove para `main`.
- BR-2: o acervo e o índice saem só do Mac do dono, por SSH. Nada do acervo passa pelo GitHub nem fica nas imagens.
- BR-3: a infraestrutura fica dentro do Always Free:
  - 2 OCPU, 12 GB e 200 GB de disco no total;
  - 20 GB de Object Storage;
  - qualquer gasto dispara alerta.
- BR-4: segredos (chaves de IA, `.env`, chave de deploy, login do Claude) nunca entram no git, em log ou em imagem.
- BR-5: só o dono usa a própria assinatura do Claude no servidor; convidados usam as próprias chaves (KBC-010 BR-5).
- BR-6: um deploy que falha no smoke volta sozinho para a versão anterior.

## Functional requirements
- FR-1: `deploy/oci/provision.sh` cria, de forma idempotente e com dry-run, os recursos:
  - VCN, gateway, rotas, security list (22/80/443) e sub-rede;
  - a VM A1 com cloud-init e o block volume anexado;
  - IP público reservado;
  - bucket de backup, dynamic group e policy restrita ao bucket;
  - orçamento.
- FR-2: o cloud-init prepara a VM:
  - instala Docker e o plugin compose;
  - endurece o SSH, liga fail2ban e unattended-upgrades;
  - cria 4 GB de swap e monta o volume em `/srv/kb-chat`;
  - libera 80/443 no iptables da imagem Oracle;
  - cria o usuário `deploy` (comando forçado) e os timers de backup e de varredura de sessões.
- FR-3: `.github/workflows/deploy.yml`, em push para `main`:
  - constrói as duas imagens arm64 e publica no GHCR com a tag do SHA;
  - faz o deploy daquele SHA;
  - confere que a versão no ar é o SHA;
  - roda o smoke pela internet.
- FR-4: `deploy/scripts/deploy.sh` executa a versão na VM:
  - recusa um `.env` sem `KB_CHAT_DOMAIN`, `GOOGLE_CLIENT_ID` ou `KB_CHAT_OWNER_EMAIL`;
  - instala o `compose.yml` e os scripts da própria versão;
  - roda o smoke e, se falhar, volta à versão anterior.
- FR-5: `deploy/scripts/smoke.sh` confere:
  - `/health`;
  - o SPA com CSP, HSTS e `nosniff`;
  - `/mcp` 404;
  - `/api/v1/topics` 401 sem sessão.
- FR-6: `deploy/scripts/rollback.sh` volta para a versão anterior (ou um SHA dado) com as imagens guardadas na VM.
- FR-7: `deploy/scripts/sync-vault.sh` envia o acervo e um snapshot consistente do índice QMD, com os caminhos trocados para `/vault`. `install-index.sh` troca o índice e reinicia a API.
- FR-8: `deploy/scripts/backup-state.sh` envia diariamente o estado criptografado e apaga o que passou de 30 dias. `restore-state.sh` restaura e guarda o estado anterior.
- FR-9: a API aceita `HOST` (padrão `127.0.0.1`) e `TRUST_PROXY` (padrão nenhum). O endpoint MCP recusa conexões que não venham do loopback.

## Non-functional requirements
- NFR-1: custo de infraestrutura US$ 0/mês, com o orçamento de US$ 1 avisando no primeiro centavo.
- NFR-2: um deploy (build + deploy + smoke) termina em ≤ 15 min.
- NFR-3: o rollback para a versão anterior leva ≤ 2 min e não depende do GHCR.
- NFR-4: a busca exata na VM fica com p95 ≤ 1 s com o índice aquecido (Q1). A semântica fica com p95 ≤ 2 s (Q2), medida com `pnpm --filter @kb-chat/api latency` apontando para o domínio.
- NFR-5: perda máxima de estado de 24 h (RPO); restauração em ≤ 30 min (RTO).
- NFR-6: TLS válido (Let's Encrypt), nota A no SSL Labs, cabeçalhos CSP/HSTS presentes.

## Acceptance criteria
- **AC-1 (FR-3, BR-1)**
  - Given um merge em `main`
  - When o workflow Deploy roda
  - Then as imagens `kb-chat-api` e `kb-chat-web` com a tag do SHA estão no GHCR
  - And o passo "The live release is this commit" passa
  - And o smoke pela internet passa
- **AC-2 (FR-4, BR-6)**
  - Given uma versão cujo smoke falha
  - When `deploy.sh` a executa
  - Then a versão anterior volta ao ar e o workflow falha
- **AC-3 (FR-6, NFR-3)**
  - Given duas versões já publicadas
  - When o dono roda `sudo rollback.sh`
  - Then a anterior fica no ar em ≤ 2 min, sem acesso ao GHCR
- **AC-4 (FR-5)**
  - Given a produção no ar
  - When alguém sem sessão chama `/api/v1/topics`
  - Then recebe 401
  - And `POST /mcp/turn` recebe 404
  - And a página traz CSP e HSTS
- **AC-5 (FR-7, BR-2)**
  - Given o acervo no Mac
  - When o dono roda `sync-vault.sh --dry-run`
  - Then vê a lista de mudanças e a config QMD com `/vault/...`, sem enviar nada
  - And sem `--dry-run`, a busca semântica na produção acha os documentos novos
- **AC-6 (FR-7)**
  - Given um acervo de origem sem tópicos, ou uma sincronização que apagaria mais que `--max-delete`
  - When o script roda
  - Then ele para antes de enviar o índice
- **AC-7 (FR-8, NFR-5)**
  - Given o timer diário
  - When ele roda
  - Then um objeto `state/kb-chat-state-<data>.tar.zst.age` aparece no bucket
  - And os com mais de 30 dias somem
  - And a restauração do mais recente no Mac → VM traz as conversas de volta
- **AC-8 (FR-1, BR-3)**
  - Given `oci.env` com `OCPUS=4`
  - When `provision.sh` roda
  - Then ele recusa
  - And com os valores padrão, o dry-run lista os recursos sem criar nenhum
- **AC-9 (FR-2)**
  - Given a VM nova
  - When o cloud-init termina
  - Then só 22/80/443 respondem de fora
  - And o login por senha é recusado
  - And `fail2ban-client status sshd` está ativo
- **AC-10 (BR-5)**
  - Given o dono logado no Claude Code da VM
  - When um convidado escolhe a assinatura do Claude
  - Then a API recusa (KBC-010)
  - And a pesquisa do dono pela assinatura funciona
- **AC-11 (FR-9)**
  - Given um token de turno válido
  - When a requisição MCP vem de um endereço que não é loopback
  - Then a API responde 404

## Test strategy
| AC | Nível | Status |
|---|---|---|
| AC-11 | Unitário da API (`mcp.test.ts`, `config.test.ts`) | verificado |
| AC-2, AC-3, AC-4, AC-5, AC-6 | Local com Docker no Mac (arm64): compose com `localhost:8443`, `deploy.sh`/`rollback.sh`/`sync-vault.sh` com SSH simulado | verificado (`work/KBC-012/local-validation.md`) |
| AC-8 | `provision.sh` com um `oci` falso (tenancy vazia) | verificado |
| AC-7 | Backup com `oci` falso num contêiner (cifra, upload, retenção) | backup e retenção verificados; restauração ponta a ponta só na VM |
| AC-1, AC-9, AC-10, NFR-1..6 | Na VM real, pelo runbook | bloqueado: conta OCI do dono |

## Open questions (do dono)
- **Conta OCI e região:**
  - criar a conta;
  - região principal: São Paulo (`sa-saopaulo-1`) ou Vinhedo (`sa-vinhedo-1`);
  - converter para Pay As You Go, que evita a recuperação por ociosidade e talvez mantenha 4/24.
  - Padrão: São Paulo + PAYG com orçamento de US$ 1.
- **Domínio:** qual nome (ex.: `kb.<seu-domínio>`) e onde fica o DNS.
- **Cliente OAuth Google:** adicionar `https://<domínio>` às origens JavaScript autorizadas (o mesmo cliente do uso local ou um novo).
- **Claude no servidor:**
  - aceitar os termos (só o dono, binário oficial) e fazer o `claude /login` por SSH;
  - ou usar só chaves (OpenRouter).
  - Padrão: assinatura só do dono.
- **Sincronizar o acervo:** autorizar o primeiro `sync-vault.sh` (envia ~325 MB do tópico e ~720 MB do índice).
- **SSH:** liberar a porta 22 para qualquer origem (necessário para os runners do GitHub) ou restringir e fazer o deploy por outro caminho. Padrão: aberta, só chave, fail2ban.
- **Texto da tela de login:** "Seus dados ficam neste computador." deixa de ser verdade na produção. Fica para um item de UI.

## References
- ADR 0010 (produção na OCI Always Free com Compose), ADR 0008 (login e sessões), ADR 0007 (assinaturas pelos CLIs), ADR 0002 (QMD MCP).
- Runbook: `docs/deploy/runbook.md`. Arquivos: `deploy/`, `apps/api/Dockerfile`, `apps/web/Dockerfile`, `.github/workflows/deploy.yml`.

## Definition of ready
- [x] Story, scope e outcome
- [x] BR/FR cobertos por AC
- [x] NFRs mensuráveis
- [x] Nível de teste por AC
- [x] Referências
