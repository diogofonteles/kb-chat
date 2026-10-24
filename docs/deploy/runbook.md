# Runbook — kb-chat em produção na Oracle Cloud (Always Free)

Decisão e motivos: [ADR 0010](../adr/0010-deploy-oracle-cloud-always-free.md). Item: [KBC-012](../backlog/KBC-012-deploy-oracle-cloud.md).

Os passos marcados com **👤 DONO** só o dono pode fazer: conta, pagamento, DNS, Google, login do Claude e aprovação do envio do acervo. O resto são comandos prontos.

```
Mac do dono ──rsync/SSH──▶ VM A1 (Ubuntu 24.04, /srv/kb-chat no block volume)
GitHub (merge em main) ──imagens arm64──▶ GHCR ──pull──▶ VM: Caddy :443 → API :3000 (rede privada)
VM ──backup diário cifrado (age)──▶ Object Storage (bucket privado)
```

## 0. Limites que valem (verificados em 2026-10-24)

- Ampere A1 Always Free: **2 OCPU e 12 GB no total** (era 4/24 até junho de 2026).
- Disco: 200 GB somando boot e block volumes (usamos 50 + 50).
- Object Storage: 20 GB. Saída de dados: 10 TB/mês.
- **Ociosidade:** uma VM Always Free pode ser parada se, por 7 dias, CPU (p95), rede e memória ficarem abaixo de 20%. Converter a conta para **Pay As You Go** evita isso e continua sem custo enquanto o uso ficar dentro do Always Free. É o padrão recomendado (passo 1).

## 1. 👤 DONO — conta OCI, região e guarda de custo

1. Crie a conta em <https://www.oracle.com/cloud/free/>. A **região principal** (home region) não muda depois, e o Always Free só existe nela. Sugestão: `sa-saopaulo-1`.
2. **Recomendado:** em *Billing → Upgrade and Manage Payment*, converta para **Pay As You Go**. Isso evita a recuperação por ociosidade. O orçamento do passo 3 avisa no primeiro centavo.
3. Crie um compartimento `kb-chat` (*Identity → Compartments*) e anote o OCID dele e o da tenancy.
4. Instale e configure a OCI CLI no Mac:
   ```bash
   brew install oci-cli
   oci setup config        # gera ~/.oci/config e uma chave de API; suba a pública no Console
   oci iam region list --output table   # teste
   ```

## 2. Chaves SSH (no Mac)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/kb-chat-ci -C kb-chat-ci -N ''   # chave do GitHub Actions (só faz deploy)
ls ~/.ssh/id_ed25519.pub                                         # sua chave pessoal (usuário ubuntu)
age-keygen -o ~/.config/kb-chat/backup-age.key                   # brew install age; guarde a chave privada fora do Mac também
age-keygen -y ~/.config/kb-chat/backup-age.key                   # a pública (age1...) vai para a VM
```

A chave privada do `age` **nunca** vai para a VM. Sem ela os backups não abrem: guarde uma cópia no gerenciador de senhas.

## 3. Provisionar (dry-run primeiro)

```bash
mkdir -p ~/.config/kb-chat
cp deploy/oci/oci.env.example ~/.config/kb-chat/oci.env   # preencha OCIDs, região, e-mail do alerta
deploy/oci/provision.sh --env ~/.config/kb-chat/oci.env            # só lista o que criaria
deploy/oci/provision.sh --env ~/.config/kb-chat/oci.env --apply    # cria o que falta (idempotente)
```

- O script recusa tamanhos acima do Always Free (`OCPUS>2`, `MEMORY_GB>12`, disco>200 GB).
- **"Out of host capacity"**: é falta temporária de A1 na região. Tente outro `AVAILABILITY_DOMAIN` ou mais tarde, e rode de novo; ele continua de onde parou.
- Anote o **IP público reservado** e o **namespace** impressos no fim.

Espere o cloud-init terminar, uns 5–10 min:

```bash
ssh ubuntu@<IP> 'cloud-init status --wait; test -f /var/lib/kb-chat-cloud-init-done && echo pronto'
```

## 4. 👤 DONO — DNS e Google

1. **DNS:** crie um registro `A` de `kb.<seu-domínio>` apontando para o IP reservado (TTL 300). Confira com `dig +short kb.<seu-domínio>`.
2. **Google:** no [Console de credenciais](https://console.cloud.google.com/apis/credentials), no cliente OAuth do kb-chat, adicione `https://kb.<seu-domínio>` em **Authorized JavaScript origins**. Mantenha `http://localhost:4200` para o uso local.

## 5. Instalar os arquivos de deploy e o `.env` na VM

```bash
deploy/oci/bootstrap-vm.sh ubuntu@<IP>
ssh ubuntu@<IP>
sudo nano /srv/kb-chat/deploy/.env     # root, 0600: preencha a partir de deploy/.env.example
```

Obrigatórios: `KB_CHAT_DOMAIN`, `GOOGLE_CLIENT_ID`, `KB_CHAT_OWNER_EMAIL`. Sem eles, `deploy.sh` recusa e a API não sobe.

- `WEB_ORIGIN` fica `https://$KB_CHAT_DOMAIN` (é a origem que o CSRF aceita).
- `ALLOWED_HOSTS` e `TRUST_PROXY` vêm do `compose.yml`.
- Chaves de IA, se usar, entram **só** aqui.

Backup (root, 0600):

```bash
sudo tee /srv/kb-chat/deploy/backup.env >/dev/null <<'EOF'
BACKUP_BUCKET=kb-chat-backups
BACKUP_NAMESPACE=<namespace do passo 3>
BACKUP_AGE_RECIPIENT=age1...
BACKUP_KEEP_DAYS=30
EOF
sudo chmod 0600 /srv/kb-chat/deploy/backup.env
sudo /srv/kb-chat/deploy/scripts/backup-state.sh --dry-run
```

## 6. 👤 DONO — ambiente `production` no GitHub

Em *Settings → Environments → New environment* `production`, configure:

| Tipo | Nome | Valor |
|---|---|---|
| secret | `DEPLOY_SSH_KEY` | conteúdo de `~/.ssh/kb-chat-ci` (privada) |
| secret | `DEPLOY_KNOWN_HOSTS` | saída de `ssh-keyscan -t ed25519 <IP>` |
| secret | `DEPLOY_HOST` | o IP reservado |
| variable | `KB_CHAT_DOMAIN` | `kb.<seu-domínio>` |
| variable | `DEPLOY_USER` | `deploy` (opcional) |

- Proteja o ambiente com *Deployment branches: main only*.
- Opcional: *Required reviewers*, para aprovar cada publicação.

Pelo `gh`, sem colar o valor no comando:

```bash
gh secret set DEPLOY_SSH_KEY --env production < ~/.ssh/kb-chat-ci
ssh-keyscan -t ed25519 <IP> | gh secret set DEPLOY_KNOWN_HOSTS --env production
gh secret set DEPLOY_HOST --env production        # pede o valor
gh variable set KB_CHAT_DOMAIN --env production --body kb.<seu-domínio>
```

## 7. 👤 DONO — acervo e índice (aprovar o envio)

O acervo vai do Mac por SSH, **nunca pelo GitHub**. Primeiro veja o que mudaria:

```bash
deploy/scripts/sync-vault.sh --host ubuntu@<IP> --dry-run
deploy/scripts/sync-vault.sh --host ubuntu@<IP> --with-models   # 1ª vez: também os modelos (~2 GB)
```

- O primeiro envio leva ~325 MB do tópico e ~720 MB do índice.
- Depois de `kb ingest` + `qmd embed` no Mac, rode de novo sem `--with-models`: só vão as diferenças.
- O script recusa um acervo sem tópicos.
- Com mais de `--max-delete` (200) remoções, ele para antes de mexer no índice.

## 8. Primeiro deploy

O deploy é o merge de `develop` em `main` (**decisão do dono**), ou *Actions → Deploy → Run workflow* em `main`.

- O workflow constrói as imagens arm64 e faz o deploy do SHA.
- Ele confere que a versão no ar é aquele SHA e roda o smoke pela internet.

Para acompanhar: `devflow-deploy-run main --workflow deploy.yml --wait 20` (execução casada pelo SHA).

Smoke à mão, de qualquer lugar:

```bash
deploy/scripts/smoke.sh https://kb.<seu-domínio>
```

Ele confere: `/health`; a página com CSP e HSTS; `/mcp` 404; `/api/v1/topics` 401 sem sessão.

## 9. 👤 DONO — login do Claude (opcional)

Só o dono usa a própria assinatura (KBC-010 BR-5).

- Os termos do Claude Code permitem entrar com a **própria** assinatura no binário oficial, mesmo hospedado.
- Eles **proíbem** atender outras pessoas com ela.
- Convidados usam as próprias chaves.

```bash
ssh -t ubuntu@<IP> 'cd /srv/kb-chat/deploy && sudo docker compose --env-file .env --env-file release.env exec api claude'
# dentro do Claude Code: /login → abra a URL no navegador do Mac → cole o código → /exit
```

O login fica em `/srv/kb-chat/claude` (no volume e no backup cifrado). Depois, em ⚙ Configurações → "Assinatura do Claude" → "Testar conexão".

## 10. Rotina

| O quê | Como |
|---|---|
| Publicar | merge em `main` (o dono decide) |
| Voltar uma versão | `ssh ubuntu@<IP> sudo /srv/kb-chat/deploy/scripts/rollback.sh` (ou `rollback.sh <sha>`; `--list` mostra o histórico) |
| Atualizar o acervo | `deploy/scripts/sync-vault.sh --host ubuntu@<IP>` |
| Logs | `ssh ubuntu@<IP> 'cd /srv/kb-chat/deploy && sudo docker compose --env-file .env --env-file release.env logs -f --tail 200'` |
| Saúde | `curl -s https://kb.<seu-domínio>/health` (`degraded` = QMD parado, busca pelo `kb`) |
| Uso de recursos | `ssh ubuntu@<IP> 'sudo docker stats --no-stream; free -h; df -h /srv/kb-chat'` |
| Backups | `systemctl list-timers kb-chat-*`; `journalctl -u kb-chat-backup` |
| Sessões abandonadas | timer `kb-chat-sweep-sessions` (diário, apaga arquivos sem uso há 31 dias) |
| Atualizações do sistema | unattended-upgrades, com reboot às 05:30 UTC quando precisa; os contêineres voltam sozinhos |

O deploy falhou no smoke? O `deploy.sh` já voltou para a versão anterior, e o workflow fica vermelho. Leia `gh run view <run> --log-failed` e os logs da API antes de tentar de novo.

## 11. Restaurar o estado

```bash
oci os object list --namespace <ns> --bucket-name kb-chat-backups --prefix state/ --output table
oci os object get --namespace <ns> --bucket-name kb-chat-backups --name state/kb-chat-state-<stamp>.tar.zst.age --file backup.age
age --decrypt --identity ~/.config/kb-chat/backup-age.key backup.age |
  ssh ubuntu@<IP> sudo /srv/kb-chat/deploy/scripts/restore-state.sh -
```

- O estado atual fica guardado em `/srv/kb-chat/state.before-restore-<stamp>`.
- O acervo e o índice não estão no backup: a fonte é o Mac, use `sync-vault.sh`.

Ensaio sugerido: um a cada trimestre.

## 12. Reconstruir a VM (perdida ou recuperada)

1. A VM foi só parada por ociosidade? Ligue-a no Console. Os volumes ficam intactos.
2. Para recriar: termine a instância **sem** apagar o block volume e rode `provision.sh --apply`. Ele recria a VM, reanexa o volume e mantém o IP reservado.
3. Depois rode `bootstrap-vm.sh` (o `.env` antigo continua no volume) e dispare o workflow Deploy.

## 13. Custo (ficar no Always Free)

- `provision.sh` recusa formas e tamanhos pagos.
- O orçamento `kb-chat-budget` (US$ 1/mês) manda e-mail no primeiro centavo.
- Não crie outra VM A1, nem volumes além de 200 GB no total, nem backups de volume além de 5.
- Confira mensalmente em *Billing → Cost Analysis*: deve ficar US$ 0,00.
