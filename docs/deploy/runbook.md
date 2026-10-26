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
deploy/oci/check-cli.sh                                    # confere que a OCI CLI instalada tem todos os comandos do script
deploy/oci/provision.sh --env ~/.config/kb-chat/oci.env            # só lista o que criaria
deploy/oci/provision.sh --env ~/.config/kb-chat/oci.env --apply    # cria o que falta (idempotente)
```

- O orçamento (`BUDGET_USD`) é na moeda de cobrança da conta; o alerta dispara em 1% do gasto real.
- O script recusa tamanhos acima do Always Free (`OCPUS>2`, `MEMORY_GB>12`, disco>200 GB).
- **"Out of host capacity"**: é falta temporária de A1 na região. Tente outro `AVAILABILITY_DOMAIN` ou mais tarde, e rode de novo; ele continua de onde parou.
- Anote o **IP público reservado** e o **namespace** impressos no fim.

Espere o cloud-init terminar, uns 5–10 min. O script `kb-chat-setup` espera a saída para a internet (o IP reservado), monta o volume e só grava o marcador de pronto quando Docker, compose, OCI CLI, o volume e os timers de backup e de sessões estão confirmados. Sem o marcador, veja `/var/log/cloud-init-output.log`:

```bash
ssh ubuntu@<IP> 'cloud-init status --wait; test -f /var/lib/kb-chat-cloud-init-done && echo pronto'
```

## 4. 👤 DONO — domínio e Google

O site precisa de um nome que aponte para o IP reservado. Escolha **um** caminho:

**A. Gratuito: subdomínio do DuckDNS** (ex.: `nova-alexandria.duckdns.org`)

1. Entre em [duckdns.org](https://www.duckdns.org) com uma das contas oferecidas (GitHub, Google etc.).
2. Em *add domain*, crie o subdomínio (ex.: `nova-alexandria`). No campo *current ip* da linha dele, coloque o **IP reservado** do passo 3 e clique em *update ip*.
3. Confira: `dig +short nova-alexandria.duckdns.org` responde o IP reservado. Como o IP reservado não muda, não é preciso rodar o atualizador do DuckDNS nem guardar o token dele na VM.
4. O Caddy pede o certificado ao Let's Encrypt pelo desafio HTTP-01 na porta 80 (já aberta pelo `provision.sh` e pelo cloud-init); o DuckDNS não precisa de registro `TXT`. O e-mail não depende desse domínio (passo 4b): o DuckDNS não dá `MX` nem `TXT`, por isso os códigos saem pelo Gmail.
5. Use `nova-alexandria.duckdns.org` como `KB_CHAT_DOMAIN` (passo 5) e na variável do GitHub (passo 6).

**B. Domínio próprio:** crie um registro `A` de `kb.<seu-domínio>` apontando para o IP reservado (TTL 300). Confira com `dig +short kb.<seu-domínio>`.

**Google:** no [Console de credenciais](https://console.cloud.google.com/apis/credentials), no cliente OAuth do kb-chat, adicione `https://<o host escolhido>` (ex.: `https://nova-alexandria.duckdns.org`) em **Authorized JavaScript origins**. Mantenha `http://localhost:4200` para o uso local. Na **tela de consentimento OAuth**, o nome do app é **Nova Alexandria** e o link da política de privacidade é `https://<o host escolhido>/privacidade` (página pública, KBC-016; o contato mostrado é `KB_CHAT_OWNER_EMAIL`).

Nos passos seguintes, `kb.<seu-domínio>` significa o host escolhido aqui.

## 4b. 👤 DONO — e-mail dos códigos (Gmail, gratuito)

O kb-chat manda por e-mail os códigos de entrada e de cadastro e os avisos de solicitação de acesso (KBC-014, ADR 0011). Sem um provedor completo a API não sobe em produção. O caminho gratuito é o SMTP do Gmail com uma senha de app (ADR 0012): envia para qualquer pessoa, até cerca de 500 destinatários por dia, e o remetente é a própria conta Gmail.

1. **Crie uma conta Gmail só para o envio** (ex.: `nova.alexandria.avisos@gmail.com`). Uma senha de app dá acesso amplo à conta; numa conta dedicada, um vazamento não expõe o seu e-mail pessoal.
2. Nessa conta, ligue a **verificação em duas etapas** ([myaccount.google.com/security](https://myaccount.google.com/security)). Sem ela o Google não oferece senha de app.
3. Crie uma **senha de app** em [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) (nome: `nova-alexandria`). Ela aparece uma vez, com 16 letras. Não cole em chat, em arquivo do repositório nem em argumento de comando.
4. Depois do passo 5 (o `.env` já existe na VM), grave o par no `.env` digitando a senha sem eco:

   ```bash
   ssh ubuntu@<IP>
   ENV=/srv/kb-chat/deploy/.env
   sudo sed -i '/^SMTP_USER=/d; /^SMTP_PASSWORD=/d' "$ENV"
   echo 'SMTP_USER=nova.alexandria.avisos@gmail.com' | sudo tee -a "$ENV" >/dev/null
   read -rsp 'Senha de app: ' SMTP_PW; echo
   printf 'SMTP_PASSWORD=%s\n' "${SMTP_PW// /}" | sudo tee -a "$ENV" >/dev/null; unset SMTP_PW
   sudo grep -c '^SMTP_PASSWORD=.' "$ENV"   # 1 (conta a linha sem mostrar o valor)
   ```

   `SMTP_HOST` (`smtp.gmail.com`) e `SMTP_PORT` (`465`, TLS desde o início) já são o padrão. O remetente fica `Nova Alexandria <SMTP_USER>`; para mudar o nome, use `KB_CHAT_EMAIL_FROM=Nome <a mesma conta>` (o Gmail troca qualquer outro endereço pelo da conta). Vindo do Resend, apague o `KB_CHAT_EMAIL_FROM` antigo, senão ele continua valendo como remetente.
5. Depois do deploy, peça um código em "Entrar com código" com o seu e-mail e confira a chegada (e a pasta de spam). A pasta *Enviados* da conta dedicada mostra cada envio.
6. Se o envio falhar, o log da API mostra só os códigos (ex.: `SMTP refused the email (EAUTH 535)` = senha de app errada ou revogada). Para trocar a senha, revogue a antiga em *apppasswords*, crie outra, repita o item 4 e recrie o contêiner da API (ele só lê o `.env` ao ser criado):

   ```bash
   cd /srv/kb-chat/deploy && sudo docker compose --env-file .env --env-file release.env up -d api
   ```

   Depois peça um código de novo para conferir.

**Alternativa: Resend** (quando houver um domínio próprio verificado). Deixe `SMTP_USER` e `SMTP_PASSWORD` vazios, crie a conta em [resend.com](https://resend.com) (3.000 e-mails por mês, 100 por dia), adicione o domínio em *Domains*, crie no DNS os registros que ele mostrar (SPF/DKIM `TXT` e `MX` de retorno) e espere **Verified**; crie uma chave **Sending access** só para esse domínio e grave `RESEND_API_KEY` (pelo mesmo `read -s`) e `KB_CHAT_EMAIL_FROM=kb-chat <nao-responda@<seu-domínio>>`. Sem domínio verificado o Resend só entrega para o dono da conta. Com o par SMTP preenchido, o Gmail tem prioridade.

SMS fica desligado (`KB_CHAT_SMS=off`): nenhum provedor é gratuito para o Brasil. Para ligar, escolha um provedor (ADR 0011 lista as opções e os preços) e peça o adaptador.

## 5. Instalar os arquivos de deploy e o `.env` na VM

```bash
deploy/oci/bootstrap-vm.sh ubuntu@<IP>
ssh ubuntu@<IP>
sudo nano /srv/kb-chat/deploy/.env     # root, 0600: preencha a partir de deploy/.env.example
```

Obrigatórios: `KB_CHAT_DOMAIN`, `GOOGLE_CLIENT_ID`, `KB_CHAT_OWNER_EMAIL`, `KB_CHAT_SECRETS_KEY` (abaixo) e **um** provedor de e-mail completo (passo 4b): `SMTP_USER` + `SMTP_PASSWORD` (Gmail) ou `RESEND_API_KEY` + `KB_CHAT_EMAIL_FROM`. Sem eles, ou com só metade do par SMTP, `deploy.sh` recusa e a API não sobe. Segredos (senha de app, chaves) entram pelo `read -s` do passo 4b, não pelo `nano` com a tela compartilhada.

**Chave mestra dos segredos (`KB_CHAT_SECRETS_KEY`, ADR 0016).** Cifra (AES-256-GCM) toda chave de IA guardada em disco: a da IA da aplicação e as de cada pessoa. Gere **uma vez, na VM**, direto no `.env`, sem mostrar o valor:

```bash
ENV=/srv/kb-chat/deploy/.env
# Só gera quando ainda não existe: uma chave nova torna ilegíveis as chaves já salvas.
if sudo grep -q '^KB_CHAT_SECRETS_KEY=.' "$ENV"; then echo 'já existe: mantida'; else
  sudo sed -i '/^KB_CHAT_SECRETS_KEY=/d' "$ENV"
  sudo sh -c "printf 'KB_CHAT_SECRETS_KEY=%s\n' \"\$(openssl rand -base64 32)\" >> $ENV"
fi
sudo grep -c '^KB_CHAT_SECRETS_KEY=.' "$ENV"   # 1 (conta a linha sem mostrar o valor)
```

- 👤 **DONO:** guarde uma cópia no seu gerenciador de senhas (`sudo cat` só nessa hora, numa sessão sua). Sem ela, as chaves salvas ficam ilegíveis e cada pessoa precisa conectar de novo; nunca a troque com chaves salvas (o mesmo vale ao restaurar o estado, passo 11).
- Ela fica só no `.env`, fora do backup do estado: o backup cifrado do estado sozinho não abre as chaves.
- **Nenhuma chave de IA vai no `.env`.** A IA da aplicação é conectada na tela (passo 9b); as variáveis `OPENROUTER_API_KEY`/`ANTHROPIC_API_KEY`/`OPENAI_API_KEY` não são lidas em produção.

- `WEB_ORIGIN` fica `https://$KB_CHAT_DOMAIN` (é a origem que o CSRF aceita).
- `ALLOWED_HOSTS` e `TRUST_PROXY` vêm do `compose.yml`.
- Chaves de IA, se usar, entram **só** aqui.

Backup (root, 0600):

```bash
sudo tee /srv/kb-chat/deploy/backup.env >/dev/null <<'EOF'
BACKUP_BUCKET=kb-chat-backups
BACKUP_NAMESPACE=<namespace do passo 3>
BACKUP_AGE_RECIPIENT=age1...
BACKUP_REGION=<região, ex. sa-saopaulo-1>
BACKUP_COMPARTMENT_OCID=<OCID do compartimento kb-chat>
EOF
sudo chmod 0600 /srv/kb-chat/deploy/backup.env
sudo /srv/kb-chat/deploy/scripts/backup-state.sh --dry-run
sudo systemctl start kb-chat-backup && sudo /srv/kb-chat/deploy/scripts/deploy.sh --status   # backup=ok ...
systemctl list-timers --all --no-pager 'kb-chat-*'   # duas linhas (backup e sessões), ambas com horário em NEXT
```

Um `backup=failed` antes deste passo é esperado: o timer pode disparar antes de o `backup.env` existir. O backup manual acima troca o status para `ok`.

👤 **DONO:** confirme o e-mail "Oracle Cloud Notifications" que chega depois do `provision.sh --apply`. Sem a confirmação, o alarme "backup ausente há 48 h" não chega.

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
- `--with-models` grava os modelos como o usuário da API (uid 10001) via `sudo` sem senha do usuário SSH; eles ficam em `/srv/kb-chat/qmd/cache/models`.
- O script recusa um acervo sem tópicos.
- Ele conta as remoções num dry-run antes de tudo. Com mais de `--max-delete` (200), recusa sem enviar nada nem apagar nada. Confira o acervo e, se for isso mesmo, rode de novo com `--max-delete <n>`.
- Se o índice novo falhar no smoke, o anterior volta sozinho.

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

A assinatura é do dono (KBC-010 BR-5); desde o KBC-024 ele pode cedê-la, por decisão própria, a pessoas escolhidas (ADR 0019).

- Os termos do Claude Code permitem entrar com a **própria** assinatura no binário oficial, mesmo hospedado.
- Eles **proíbem** atender outras pessoas com ela. Ceder a alguém (Pessoas e permissões → "Assinatura do Claude (administrador)") é um risco que o dono assume a cada confirmação: pode levar a limites ou ao bloqueio da conta.
- Os convidados usam o plano da casa ou as próprias chaves, salvo a quem o dono ceder a assinatura.

```bash
ssh -t ubuntu@<IP> 'cd /srv/kb-chat/deploy && sudo docker compose --env-file .env --env-file release.env exec api claude'
# dentro do Claude Code: /login → abra a URL no navegador do Mac → cole o código → /exit
```

O login fica em `/srv/kb-chat/claude` (no volume e no backup cifrado). Depois, em ⚙ Configurações → "Assinatura do Claude" → "Testar conexão".

**Assinatura cedida (KBC-024):**
- Se o login cair, cada pesquisa cedida falha com "faça login" e a assinatura fica indisponível por 10 minutos: quem a recebeu passa para a própria IA (ou fica sem IA) e a tela de pessoas avisa "não está disponível agora". Refaça o login com o comando acima e teste a conexão.
- Antes de voltar para uma versão anterior ao KBC-024 (rollback), revogue todas as cessões (Pessoas e permissões → outra IA): a versão anterior não lê `claude-subscription` no `people.json`, e as respostas salvas da assinatura cedida ficam ilegíveis até a volta da versão nova.

## 9b. 👤 DONO — IA da aplicação (na tela, depois do primeiro deploy)

Tudo pela interface (ADR 0016, KBC-022); nada no `.env`.

1. Entre como dono → ⚙ Configurações → **IA da aplicação** → **Conectar OpenRouter**. O OpenRouter pede login e "Authorize"; você volta para a Nova Alexandria com "Conta conectada.". (Alternativa: "Colar uma chave" com uma chave criada em openrouter.ai/settings/keys.) A chave que você usa no Mac fica no Mac: em produção, conecte de novo aqui.
2. Confira "Pedidos gratuitos hoje: 0 de 50". Com **US$ 10 comprados uma vez** na conta do OpenRouter, o limite dos modelos gratuitos sobe para 1000 por dia (sem gastar os créditos com os modelos `:free`).
3. "Modelos gratuitos": deixe "Escolher automaticamente". "Modelo pago de reserva": deixe vazio (custo zero).
4. "Para quem": o padrão "Plano da casa" atende quem não tem IA própria, com 5 pesquisas por dia. Em **Pessoas e permissões**, ajuste por pessoa (IA, "Usar sempre", pesquisas por dia, reserva paga com teto mensal) ou em lote ("Aplicar às selecionadas" / "Aplicar a todos os usuários").
5. Para você: ⚙ → IA → escolha "Assinatura do Claude" (passo 9) ou outra IA sua.

## 10. Rotina

| O quê | Como |
|---|---|
| Publicar | merge em `main` (o dono decide) |
| Voltar uma versão | `ssh ubuntu@<IP> sudo /srv/kb-chat/deploy/scripts/rollback.sh` (ou `rollback.sh <sha>`; `--list` mostra o histórico). Um segundo rollback continua voltando (C → B → A), nunca volta para a versão da qual saiu **Atenção (ADR 0017):** a primeira versão com o KBC-022 cifra as chaves de IA salvas; voltar para uma versão anterior a ela deixa essas chaves ilegíveis (as pessoas e o master conectam de novo, ou restaure o backup do estado de antes do deploy, passo 11) |
| O que está no ar | `ssh ubuntu@<IP> sudo /srv/kb-chat/deploy/scripts/deploy.sh --status` (tag das imagens em execução e saúde do backup: `ok`, `failed`, `stale` ou `never`) |
| Atualizar o acervo | `deploy/scripts/sync-vault.sh --host ubuntu@<IP>` |
| Logs | `ssh ubuntu@<IP> 'cd /srv/kb-chat/deploy && sudo docker compose --env-file .env --env-file release.env logs -f --tail 200'` |
| Saúde | `curl -s https://kb.<seu-domínio>/health` (`degraded` = QMD parado, busca pelo `kb`) |
| Uso de recursos | `ssh ubuntu@<IP> 'sudo docker stats --no-stream; free -h; df -h /srv/kb-chat'` |
| Backups | `systemctl list-timers kb-chat-*`; `journalctl -u kb-chat-backup`. Uma falha grava `failed` em `deploy/backup-status`, e todo deploy mostra um aviso. Sem backup por 48 h, o alarme do OCI manda e-mail. Há 28 dias para agir antes de a lifecycle apagar o último backup. A VM só cria objetos: a retenção de 30 dias é a lifecycle policy do bucket (`BACKUP_KEEP_DAYS` no `oci.env`) |
| Sessões abandonadas | timer `kb-chat-sweep-sessions` (diário, apaga arquivos sem uso há 31 dias) |
| Atualizações do sistema | unattended-upgrades, com reboot às 05:30 UTC quando precisa; os contêineres voltam sozinhos |

O deploy falhou (imagem com a revisão errada, `compose up`, tag em execução diferente, smoke)? O `deploy.sh` já voltou para a versão anterior, e o workflow fica vermelho. Leia `gh run view <run> --log-failed` e os logs da API antes de tentar de novo.

## 11. Restaurar o estado

```bash
oci os object list --namespace <ns> --bucket-name kb-chat-backups --prefix state/ --output table
oci os object get --namespace <ns> --bucket-name kb-chat-backups --name state/kb-chat-state-<stamp>.tar.zst.age --file backup.age
age --decrypt --identity ~/.config/kb-chat/backup-age.key backup.age |
  ssh ubuntu@<IP> sudo /srv/kb-chat/deploy/scripts/restore-state.sh -
```

- O arquivo é extraído numa pasta temporária primeiro; links e caminhos inesperados são recusados.
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
