# 0012 — Gmail SMTP with an app password as the free email provider

- Status: accepted (2026-10-25), implemented by KBC-015
- Amends: [0011](0011-access-requests-and-one-time-codes.md) (Delivery: the email provider and the production check), [0010](0010-deploy-oracle-cloud-always-free.md) (the site may run on a free DuckDNS subdomain)
- Drivers: the owner's request (2026-10-25: production must be 100% free and no domain will be bought), Q3 cost (US$ 0), KBC-014 (codes and access notices must reach anyone)

## Context

ADR 0011 sends one-time codes and access notices through Resend. Resend delivers to arbitrary recipients only from a domain verified with DNS records (SPF/DKIM `TXT`, `MX`); without one it delivers only to the account owner's own address, which makes sign-up and code sign-in useless for everyone else. The owner will not buy a domain, and the site will run on a free DuckDNS subdomain (e.g. `nova-alexandria.duckdns.org`), which offers `A`/`AAAA` records only (no `MX`/`TXT` control). Email therefore has to be decoupled from the site's domain.

## Decision

- **New adapter `SmtpEmailSender`** (`EmailSenderPort`, `nodemailer`), configured by `SMTP_HOST` (default `smtp.gmail.com`), `SMTP_PORT` (default `465`), `SMTP_USER` and `SMTP_PASSWORD` (secret: a Google app password). Port 465 uses TLS from the first byte; any other port must upgrade with STARTTLS (`requireTLS`), so the password never travels in clear. Connection, greeting, socket and DNS timeouts are 8 s, like Resend's.
- **Sender:** `KB_CHAT_EMAIL_FROM`, default `Nova Alexandria <SMTP_USER>`. Gmail sends only as the authenticated account (or a verified "send as" alias) and rewrites any other `From`.
- **Provider order** (`delivery-factory.ts`): Gmail SMTP when both `SMTP_USER` and `SMTP_PASSWORD` are set; else Resend when `RESEND_API_KEY` is set; else the development log adapter.
- **Fail closed:** setting only one half of the SMTP pair stops the API at boot in every environment (a typo, not a choice). In production (or listening beyond loopback) the API starts only with one complete provider: the SMTP pair, or `RESEND_API_KEY` + `KB_CHAT_EMAIL_FROM`. `deploy/scripts/deploy.sh` applies the same rule to the VM's `.env` before touching a release, and `deploy/compose.yml` passes every email variable through as optional (blank values are read as unset).
- **Errors never carry the secret or the message:** a failed send becomes `SMTP refused the email (<nodemailer code> <SMTP reply code>)`, e.g. `(EAUTH 535)`, with no `cause` and none of nodemailer's message or server response (which can echo a command or the body, i.e. the code).
- **A dedicated Gmail account** sends the email (runbook, step 4b): 2-step verification on, one app password named after the app, typed on the VM with `read -s`.
- **Egress:** the OCI security list allows all egress (`deploy/oci/provision.sh`) and the cloud-init firewall changes only the `INPUT` chain; OCI blocks outbound port 25 by default, not 465 or 587.
- **Resend stays** as the option for when a domain exists (it has delivery logs and does not depend on a personal-style account).

## Options considered

1. **Gmail SMTP with an app password (chosen).** Free, sends to anyone, no DNS work: Google signs gmail.com mail with DKIM and covers it with SPF/DMARC, so deliverability is good. Limits and costs below.
2. **Resend with a verified domain (ADR 0011).** Needs a domain with `MX`/`TXT`: a purchase the owner declined. Kept as the alternative.
3. **Gmail API with OAuth2 (XOAUTH2).** Narrower credential (send scope, revocable token) but needs an OAuth consent screen, a refresh-token flow and, for a sensitive scope, Google's verification or the 7-day expiry of "testing" tokens. More moving parts for one sender.
4. **Other free SMTP relays (Brevo, Mailjet, SMTP2GO free tiers).** Free tiers exist, but they also require a verified sender domain for good deliverability, or send from shared domains that land in spam; a new account and its terms to manage.
5. **Own mail server on the VM.** OCI blocks port 25 outbound by default, and a fresh IP has no reputation: mail would be rejected or filtered.

## Consequences

- About 500 recipients a day on a consumer Gmail account (Google's sending limit); kb-chat sends a handful per sign-in or request, far below it. Above the limit Google refuses for about 24 h: codes fail (logged), nothing else breaks.
- The sender is an `@gmail.com` address, not the site's domain; recipients see the display name "Nova Alexandria".
- An app password is close to a full-account credential (IMAP, SMTP on the whole mailbox, no 2-step prompt). Hence the dedicated account, the password only in the VM's root-owned 0600 `.env`, never in logs or errors, and revocation in `myaccount.google.com/apppasswords` if it leaks. Google may also revoke app passwords when the account password changes.
- One new runtime dependency (`nodemailer`, no transitive dependencies, ships its own types).
- New env vars: `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` (secret). `RESEND_API_KEY` and `KB_CHAT_EMAIL_FROM` are no longer required by `compose.yml` and `deploy.sh`; an existing Resend `.env` keeps working.
- The site domain is free too: a DuckDNS subdomain pointed at the reserved IP; Caddy gets its certificate through the HTTP-01 challenge on port 80, and the Google OAuth client lists `https://<subdomain>.duckdns.org` as an authorized origin.
