---
id: KBC-015
title: Enviar os e-mails de código e de aprovação pelo SMTP do Gmail (produção 100% gratuita)
status: in-review
slice: release-1
outcome: a produção envia códigos e avisos para qualquer pessoa sem domínio próprio e sem custo
depends_on: [KBC-014]
---

# KBC-015 — E-mails pelo SMTP do Gmail

## Story
Como dono do kb-chat, quero que a API envie os códigos de entrada e os avisos de solicitação pelo SMTP do Gmail com uma senha de app, para que a produção fique 100% gratuita sem eu precisar comprar um domínio.

Pedido do dono em 2026-10-25: a produção deve ser 100% gratuita. O Resend sem domínio verificado só entrega no e-mail do dono da conta, e o dono não vai comprar domínio. O site roda num subdomínio gratuito do DuckDNS (ex.: `nova-alexandria.duckdns.org`), que não dá controle de MX/TXT: o e-mail fica desacoplado do domínio do site.

## Scope
**In:**
- Adaptador `SmtpEmailSender` (porta `EmailSenderPort`, ADR 0011) com `nodemailer`: `smtp.gmail.com`, porta 465 com TLS implícito, timeouts de ~8 s.
- Configuração `SMTP_HOST` (padrão `smtp.gmail.com`), `SMTP_PORT` (padrão 465), `SMTP_USER` e `SMTP_PASSWORD`; remetente padrão `Nova Alexandria <SMTP_USER>` (nome do produto escolhido pelo dono).
- Escolha do provedor: SMTP quando o par usuário/senha existe, senão Resend, senão o log (só desenvolvimento).
- Deploy: `compose.yml`, `.env.example` (raiz e `deploy/`) e a checagem do `deploy.sh` aceitando qualquer provedor completo; conferência de que a OCI não bloqueia a saída na porta 465.
- Runbook: passo do Gmail (conta dedicada, verificação em duas etapas, senha de app digitada na VM com `read -s`), Resend como alternativa, e passo do DuckDNS (subdomínio, IP reservado, certificado do Caddy por HTTP-01, origem no Google OAuth).
- ADR 0012 (emenda a 0011).

**Out:**
- OAuth2 do Gmail (XOAUTH2) no lugar da senha de app.
- Fila ou reenvio automático de e-mails que falharam.
- Provedor de SMS (continua desligado, ADR 0011).
- Automação do DuckDNS (o IP é reservado e não muda; atualização periódica não é necessária).

## Business rules
- BR-1: com `SMTP_USER` e `SMTP_PASSWORD` definidos, os e-mails saem pelo SMTP, mesmo que `RESEND_API_KEY` também exista.
- BR-2: definir só um dos dois (`SMTP_USER` ou `SMTP_PASSWORD`) é erro de configuração em qualquer ambiente: a API não sobe.
- BR-3: em produção (`NODE_ENV=production` ou escutando fora do loopback), a API só sobe com um provedor completo: o par SMTP, ou `RESEND_API_KEY` com `KB_CHAT_EMAIL_FROM`.
- BR-4: pelo SMTP, o remetente padrão é `Nova Alexandria <SMTP_USER>` (o Gmail só envia como a própria conta); `KB_CHAT_EMAIL_FROM` substitui quando definido.
- BR-5: nenhuma mensagem de erro de envio contém a senha nem o corpo do e-mail (o código).

## Functional requirements
- FR-1: `SmtpEmailSender.send` deve enviar `from`, `to`, `subject` e `text` pelo transporte SMTP; a porta 465 usa TLS desde o início, outra porta usa STARTTLS obrigatório. (BR-4)
- FR-2: uma falha do servidor ou de rede deve virar um erro com o código do nodemailer e o código de resposta SMTP, sem a senha nem o corpo. (BR-5)
- FR-3: `createDelivery` deve escolher SMTP, depois Resend, depois o log. (BR-1)
- FR-4: `loadConfig` deve recusar a metade do par SMTP; `assertDeliveryConfigured` deve recusar a produção sem provedor completo. (BR-2, BR-3)
- FR-5: `deploy/compose.yml` repassa as variáveis SMTP e deixa as do Resend opcionais; `deploy.sh` recusa um `.env` sem provedor completo ou com metade do par SMTP. (BR-2, BR-3)

## Non-functional requirements
- NFR-1: conexão, saudação e socket do SMTP com timeout de 8 s (como o Resend), para que um servidor parado não segure o envio.
- NFR-2: nenhum envio real em teste nem na validação local; nenhuma credencial real no repositório, em argumentos ou em log.
- NFR-3: custo zero: Gmail gratuito (cerca de 500 destinatários por dia), DuckDNS gratuito, OCI Always Free.

## Acceptance criteria
- **AC-1 (FR-1, BR-4)**
  - Given um `SmtpEmailSender` com usuário `kbchat@gmail.com` e um transporte de teste
  - When ele envia um código para `ana@example.com`
  - Then o transporte recebe `from` `Nova Alexandria <kbchat@gmail.com>`, o destinatário, o assunto e o texto
- **AC-2 (FR-1)**
  - Given a porta 465
  - When o transporte é criado
  - Then ele usa TLS implícito (`secure: true`), autenticação com usuário e senha e timeouts de 8 s; com a porta 587, `secure: false` e `requireTLS: true`
- **AC-3 (FR-2, BR-5)**
  - Given um servidor que recusa a autenticação (535)
  - When o envio falha
  - Then o erro diz "SMTP refused the email (EAUTH 535)" e não contém a senha nem o código
- **AC-4 (FR-3, BR-1)**
  - Given `SMTP_USER`, `SMTP_PASSWORD` e `RESEND_API_KEY`
  - When a entrega é montada
  - Then o e-mail sai pelo SMTP; sem o par, pelo Resend; sem nenhum, pelo log
- **AC-5 (FR-4, BR-2)**
  - Given só `SMTP_USER` (ou só `SMTP_PASSWORD`), em desenvolvimento
  - When a configuração é carregada
  - Then a API para dizendo que falta a outra metade
- **AC-6 (FR-4, BR-3)**
  - Given `NODE_ENV=production`
  - When há só o par SMTP, ou só Resend completo
  - Then a API sobe; sem nenhum, para com a mensagem dos dois caminhos
- **AC-7 (FR-5)**
  - Given o `.env` da VM com o par SMTP e sem Resend
  - When `deploy.sh` checa as variáveis
  - Then ele segue; sem provedor completo, ou com metade do par, recusa antes de mexer na release
- **AC-8 (NFR-2)**
  - Given a API local com o par SMTP apontando para um servidor SMTP de captura local
  - When alguém pede um código de entrada
  - Then a mensagem chega ao servidor de captura (nenhum e-mail real) e, sem SMTP, o código aparece no log como antes

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | unitário (adaptador) | transporte injetado |
| AC-2 | unitário (adaptador) | opções passadas à fábrica do transporte |
| AC-3 | unitário (adaptador) | erro simulado com `code` e `responseCode` |
| AC-4 | unitário (`delivery-factory`) | |
| AC-5 | unitário (config) | |
| AC-6 | unitário (config) | |
| AC-7 | script (bash) com `.env` temporário | validação local |
| AC-8 | validação local | servidor SMTP de captura em processo, API em porta alternativa |

## References
ADRs: `docs/adr/0011-access-requests-and-one-time-codes.md`, `docs/adr/0012-gmail-smtp-email-provider.md`, `docs/adr/0010-deploy-oracle-cloud-always-free.md` · Runbook: `docs/deploy/runbook.md` (passos 4 e 4b)

## Open questions
Nenhuma. Premissa: o dono cria uma conta Gmail dedicada para o envio (recomendado no runbook); o código funciona também com a conta pessoal.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
