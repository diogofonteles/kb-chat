---
id: KBC-016
title: Dar ao produto o nome "Nova Alexandria" em todo texto que a pessoa vê
status: done
slice: release-1
outcome: quem abre o site, recebe um e-mail ou lê a documentação do produto vê o nome "Nova Alexandria", nunca "kb-chat"
depends_on: [KBC-014, KBC-015]
---

# KBC-016 — Nome do produto: Nova Alexandria

## Story
Como dono do produto, quero que o site, os e-mails e a documentação para o usuário usem o nome "Nova Alexandria", para que o produto publicado em `nova-alexandria.duckdns.org` tenha uma identidade própria em vez do nome técnico do repositório.

Pedido do dono em 2026-10-25: o nome é **Nova Alexandria**. A Biblioteca de Alexandria guardava todo o conhecimento do mundo antigo, e é em Alexandria que surge o Corpus Hermeticum: uma biblioteca de conhecimento universal com um núcleo esotérico (o hermetismo) que também vai guardar outras ciências.

## Scope
**In:**
- Título da aba do navegador (`index.html`; não há títulos por rota).
- Marca no cabeçalho do chat (sem acervo escolhido) e na tela de entrada.
- Textos da entrada, do assistente de início, das Configurações (Preferências, provedor de IA, Sobre) e das dicas de provedor.
- Assuntos e corpos dos e-mails e do SMS: código de cadastro e de entrada, já tem acesso, solicitação em análise, solicitação recusada, aviso de nova solicitação aos masters e aprovação; assinatura dos e-mails.
- Nome do remetente nos exemplos de configuração (`KB_CHAT_EMAIL_FROM`) e no remetente de teste do Resend; título do app enviado ao OpenRouter (`x-title`).
- Testes unitários, de integração e E2E que conferem o nome antigo.
- Documentação para o usuário: introdução do `README`, visão, contexto e telas (`docs/product`, `docs/design/screens.md`).
- Política de privacidade pública em `/privacidade` (acréscimo do dono em 2026-10-25: o Google exige o link para publicar a tela de consentimento OAuth "Nova Alexandria"): abre sem sessão, link "Privacidade" na tela de entrada, texto curto em pt-BR fiel ao que o app faz, contato do dono vindo da configuração (`KB_CHAT_OWNER_EMAIL` em `GET /api/v1/auth/config`, campo `privacyContactEmail`), data de "Última atualização"; Caddy serve a rota com o mesmo CSP e o smoke de produção confere a rota.

**Out:**
- Nome do repositório, pacotes (`@kb-chat/*`), variáveis de ambiente (`KB_CHAT_*`), pasta de estado (`~/.kb-chat`), chaves do `localStorage`, cookie de sessão, valor do cabeçalho CSRF, ids dos servidores MCP, imagens e serviços Docker, caminhos da VM (`/srv/kb-chat`), recursos da OCI e o histórico das ADRs.
- Novo ícone: o atual (`favicon.svg`) é um glifo de linhas, sem o texto "kb"; continua.
- Manifesto de app (PWA): não existe.

## Business rules
- BR-1: o nome do produto em texto para o usuário é sempre "Nova Alexandria", com as duas iniciais maiúsculas.
- BR-2: o nome é feminino em português ("a Nova Alexandria"): "da", "na", "à", "pela"; pronome "ela".
- BR-4: a política só afirma o que o código faz (dados, prestadores, prazos) e o básico da LGPD; nenhum e-mail pessoal fica escrito no repositório.
- BR-3: identificadores internos continuam `kb-chat` (lista em Out), para não quebrar sessões, preferências salvas, deploy nem integrações.

## Functional requirements
- FR-1: a aba do navegador mostra "Nova Alexandria". (BR-1)
- FR-2: a tela de entrada mostra o título "Nova Alexandria" e a nota "Suas conversas e configurações ficam no servidor da Nova Alexandria." (BR-1, BR-2)
- FR-3: o cabeçalho do chat sem acervo, o assistente de início ("Boas-vindas à Nova Alexandria"), as Preferências ("Ao abrir a Nova Alexandria"), o provedor de IA e o Sobre usam o novo nome com a concordância certa. (BR-1, BR-2)
- FR-4: todos os e-mails e o SMS usam o novo nome no assunto, no corpo e na assinatura "— Nova Alexandria". (BR-1, BR-2)
- FR-5: nenhum identificador da lista Out muda. (BR-3)
- FR-6: `/privacidade` mostra a política com ou sem sessão; a tela de entrada tem o link "Privacidade"; a política leva de volta ao início. (BR-4)
- FR-7: `GET /api/v1/auth/config` (público) devolve `privacyContactEmail` (o `KB_CHAT_OWNER_EMAIL`, ou `null`); a política mostra esse e-mail como `mailto:` ou, sem ele, "fale com o administrador que aprovou o seu acesso". (BR-4)
- FR-8: o smoke de produção confere que `/privacidade` serve a SPA sem sessão; o Caddy a serve com `Cache-Control: no-cache` como `/`. (FR-6)

## Non-functional requirements
- NFR-1: nenhum "kb-chat" visível ao usuário no código do site e da API (verificado por `git grep`, com as sobras internas listadas).
- NFR-2: textos de UI continuam externalizados com `i18n`/`$localize`, os mesmos ids.
- NFR-3: WCAG 2.2 AA mantido nas telas tocadas (axe sem violações sérias), 1440 px e 390 px sem quebra do título.

## Acceptance criteria
- **AC-1 (FR-1)**
  - Given qualquer tela do site
  - When a página carrega
  - Then o título da aba é "Nova Alexandria"
- **AC-2 (FR-2, BR-2)**
  - Given uma pessoa sem sessão
  - When ela abre o site
  - Then vê o título de nível 1 "Nova Alexandria" e a nota "Suas conversas e configurações ficam no servidor da Nova Alexandria."
- **AC-3 (FR-3, BR-2)**
  - Given uma pessoa com sessão, sem acervo escolhido
  - When o chat abre
  - Then o título de nível 1 é "Nova Alexandria"; no assistente de início, "Boas-vindas à Nova Alexandria"; nas Configurações, "Ao abrir a Nova Alexandria" e o Sobre "… no servidor da Nova Alexandria …"
- **AC-4 (FR-4, BR-2)**
  - Given uma pessoa que pede um código de entrada, de cadastro, ou uma solicitação de acesso, e um master que aprova
  - When os e-mails são montados
  - Then os assuntos são "Seu código de acesso à Nova Alexandria", "Confirme seu e-mail na Nova Alexandria", "Você já tem acesso à Nova Alexandria", "Sua solicitação de acesso à Nova Alexandria está em análise", "Seu acesso à Nova Alexandria foi aprovado", e cada corpo termina com "— Nova Alexandria"
- **AC-5 (FR-4)**
  - Given o SMS de código ligado (`log` em desenvolvimento)
  - When o código é enviado
  - Then o texto começa com "Nova Alexandria: seu código de acesso é"
- **AC-6 (FR-5, BR-3, NFR-1)**
  - Given o código depois da mudança
  - When se busca "kb-chat" no site e na API
  - Then só aparecem identificadores internos da lista Out e comentários; as chaves `kb-chat.*` do `localStorage` e o cookie `kbchat_session` continuam iguais (preferências e sessões existentes seguem valendo)

- **AC-7 (FR-6, FR-7)**
  - Given uma pessoa sem sessão
  - When ela abre `/privacidade`
  - Then vê o título da aba "Privacidade — Nova Alexandria", o h1 "Política de privacidade", as seções, o contato do dono como `mailto:` e a data de atualização, sem o botão do Google, e o axe não acha violações sérias
- **AC-8 (FR-6)**
  - Given a tela de entrada
  - When a pessoa clica em "Privacidade" e depois em "Voltar à Nova Alexandria"
  - Then vai para `/privacidade` e volta à entrada, com o título da aba "Nova Alexandria" de novo; com sessão, volta ao chat
- **AC-9 (FR-7)**
  - Given a API sem `KB_CHAT_OWNER_EMAIL` exposto (contato `null`)
  - When a política abre
  - Then não há link de e-mail e aparece "fale com o administrador que aprovou o seu acesso"
- **AC-10 (FR-8)**
  - Given a produção depois do deploy
  - When o smoke roda
  - Then `/privacidade` responde 200 com a SPA

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | E2E (Playwright) | `toHaveTitle` na entrada e no chat |
| AC-2 | unitário (componente) + E2E | `session-shell.spec`, `auth.spec` |
| AC-3 | unitário (componente) + E2E | `chat-page.spec`, `settings.spec`, onboarding |
| AC-4 | integração (API) | `access-requests.integration.test` com o remetente de log |
| AC-5 | unitário | `notifier.test` |
| AC-6 | `git grep` + testes existentes de `localStorage`/cookie | validação local |
| AC-7 | E2E (`privacy.spec.ts`) + unitário (`privacy-page.spec`, `session-shell.spec`) + integração (`auth.integration.test`: `privacyContactEmail`) | 1440 e 390 |
| AC-8 | E2E (`privacy.spec.ts`) + unitário (`login-page.spec`: link) | |
| AC-9 | unitário (`privacy-page.spec`) | |
| AC-10 | script (`deploy/scripts/smoke.sh`, `check_privacy`) | roda no deploy de `main` |

## References
Telas: `docs/design/screens.md` (T10 entrada, Configurações, assistente, T11 privacidade) · Runbook: `docs/deploy/runbook.md` (tela de consentimento OAuth) · ADRs: `docs/adr/0011-access-requests-and-one-time-codes.md`, `docs/adr/0012-gmail-smtp-email-provider.md`

## Open questions
Nenhuma. Premissa: o ícone atual continua (não mostra "kb"); um ícone próprio da marca pode vir num item futuro.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
