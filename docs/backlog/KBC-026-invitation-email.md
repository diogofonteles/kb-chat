---
id: KBC-026
title: "E-mail de convite: enviar, mostrar o status e reenviar"
status: in-review
slice: release-1
outcome: quem é convidado recebe um e-mail com o link e o jeito de entrar; o master vê na lista se o convite saiu, falhou ou já virou acesso, e reenvia sem abusar do provedor
depends_on: [KBC-010, KBC-014, KBC-015]
---

# KBC-026 — E-mail de convite

## Story
Como master, quero que a pessoa que eu convido receba um e-mail dizendo quem a convidou, onde entrar e como entrar, e quero ver na lista se o convite saiu, para não precisar avisar cada pessoa por fora nem adivinhar se ela já entrou.

Pedido do dono em 2026-10-26: hoje o convite em "Pessoas e permissões" só libera o acesso; nenhum e-mail sai.

## Scope
**In:**
- Ao convidar, um e-mail em texto puro "Você foi convidado para a Nova Alexandria" sai pelo provedor configurado (Gmail SMTP em produção, ADR 0012; log em desenvolvimento; caixa em memória nos testes e no E2E).
- Opção "Não enviar e-mail de convite" no formulário (desmarcada: o padrão é enviar).
- Status na lista: "Ativo" depois do primeiro acesso; antes dele, "Convite enviado em <data>", "Falha ao enviar o convite" ou "Ainda não entrou" (sem e-mail de convite).
- "Reenviar convite" (ou "Enviar convite", quando nenhum saiu) na pessoa aberta, para quem ainda não entrou, com limite por convidado e mensagem clara quando limitado.

**Out:**
- Link de convite com token ou expiração (o convite é o e-mail na lista, como na ADR 0008).
- Saber de fato se o e-mail é uma conta Google (o texto explica os dois caminhos).
- E-mail HTML, anexos ou personalização além do nome de quem convidou.
- Mudanças em solicitações de acesso (KBC-014): a pessoa aprovada continua recebendo o e-mail de aprovação.

## Business rules
- BR-1: só masters convidam e reenviam (`{ master: true }`, ADR 0008); a resposta a um não-master é 403 antes de olhar o e-mail, então nunca revela se o endereço existe.
- BR-2: o e-mail diz quem convidou (nome do master; sem nome, o e-mail dele), o link do site (`WEB_ORIGIN`) e os dois jeitos de entrar: "Fazer login com o Google", se o endereço for uma conta Google, ou "Entrar com código", com um código enviado ao mesmo endereço.
- BR-3: no máximo 1 e-mail de convite a cada 10 minutos e 5 a cada 24 horas por convidado (o envio do próprio convite conta). Contadores em memória, como os de código (ADR 0011, ND-22): um reinício os zera.
- BR-4: uma falha de envio nunca desfaz o convite; fica registrada na pessoa e no log, sem o corpo do e-mail.
- BR-5: "Ativo" vem do primeiro acesso (`lastLoginAt`), por Google ou por código. Pessoas já existentes sem dados de convite aparecem como "Ainda não entrou" (ou "Ativo"); nada precisa ser regravado.
- BR-6: quem já entrou não recebe reenvio (400) e não mostra o botão.

## Functional requirements
- FR-1: `POST /api/v1/people` aceita `sendEmail` (booleano, padrão `true`); com `true`, envia o convite e responde 201 com a pessoa e o resultado do envio em `invitation`. (BR-2, BR-3, BR-4)
- FR-2: `Person` ganha `invitation: { sentAt, failedAt } | null`; o registro guardado ganha o mesmo campo opcional. (BR-4, BR-5)
- FR-3: `POST /api/v1/people/:id/invitation` (master) reenvia: 200 com a pessoa; 429 `RATE_LIMITED` com `details.retryAt` quando limitado; 404 para quem não existe; 400 para quem já entrou. (BR-1, BR-3, BR-6)
- FR-4: o formulário de convite tem a caixa "Não enviar e-mail de convite"; o aviso depois de convidar diz se o e-mail saiu, não foi pedido ou falhou. (BR-4)
- FR-5: cada linha mostra o status (FR-2, BR-5); a falha aparece com ícone e texto, não só cor.
- FR-6: a pessoa aberta mostra "Reenviar convite"/"Enviar convite" enquanto não entrou; o resultado aparece no status da pessoa, com o horário a partir do qual pode reenviar quando limitado. (BR-3, BR-6)

## Non-functional requirements
- NFR-1: nenhum e-mail real em testes ou validação local (caixa em memória ou adaptador de log).
- NFR-2: WCAG 2.2 AA na caixa, no status e no botão (nativos, foco visível, alvo ≥ 44 px), em 1440 e 390 px, sem rolagem horizontal.
- NFR-3: o log de falha leva o erro já saneado do provedor (ADR 0012) e o id da pessoa; nunca o texto do e-mail.

## Acceptance criteria
- **AC-1 (FR-1, BR-2)**
  - Given um master com nome "Ana Master"
  - When convida `novo@exemplo.com` sem marcar "Não enviar e-mail de convite"
  - Then sai um e-mail para `novo@exemplo.com` com o assunto "Você foi convidado para a Nova Alexandria", o nome "Ana Master", o link do site, "Fazer login com o Google" e "Entrar com código"; a pessoa volta com `invitation.sentAt`
- **AC-2 (FR-1, FR-4)**
  - Given o formulário de convite
  - When o master marca "Não enviar e-mail de convite" e convida
  - Then nenhum e-mail sai, a pessoa volta com `invitation: null` e o aviso diz que o convite foi criado sem e-mail
- **AC-3 (FR-2, FR-5, BR-5)**
  - Given uma pessoa com convite enviado, uma que já entrou, uma com falha e uma antiga sem dados de convite
  - When o master abre a lista
  - Then as linhas mostram "Convite enviado em <dd/mm/aaaa hh:mm>", "Ativo" (com o último acesso), "Falha ao enviar o convite" e "Ainda não entrou"
- **AC-4 (FR-3, FR-6, BR-3)**
  - Given um convite enviado há menos de 10 minutos
  - When o master clica em "Reenviar convite"
  - Then a API responde 429 com `retryAt`, nada é enviado e a tela diz "Este convite foi enviado há pouco. Você pode reenviar a partir de <hora>."; depois de 10 minutos o reenvio sai, até 5 em 24 horas
- **AC-5 (FR-1, FR-3, BR-4)**
  - Given o provedor de e-mail recusando o envio
  - When o master convida ou reenvia
  - Then a pessoa continua na lista com "Falha ao enviar o convite", o aviso de erro diz que o convite continua valendo e o log tem o erro sem o texto do e-mail
- **AC-6 (BR-1)**
  - Given uma pessoa que não é master (ou sem sessão)
  - When chama `POST /api/v1/people` ou `POST /api/v1/people/:id/invitation`
  - Then recebe 403 (401 sem sessão), igual para e-mails que existem ou não, e nada é enviado
- **AC-7 (BR-6)**
  - Given uma pessoa que já entrou
  - When o master abre a pessoa ou chama o reenvio
  - Then não há botão de reenvio e a API responde 400

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | unitário (`messages.test.ts`, `invitations.test.ts`) + integração (`people-invitation.integration.test.ts`) + E2E (`invitation.spec.ts`, caixa do servidor E2E) | — |
| AC-2 | integração + unitário (`people-panel.spec`) + E2E | — |
| AC-3 | unitário (`invitation-status.spec`, `people-panel.spec`) | dados antigos sem `invitation` |
| AC-4 | unitário (`sliding-windows.test.ts`, `invitations.test.ts` com relógio falso) + integração + E2E (limite logo após o convite) | — |
| AC-5 | unitário (`invitations.test.ts`, provedor que falha) + integração + `people-panel.spec` | — |
| AC-6 | integração | membro e sem sessão |
| AC-7 | integração + `people-panel.spec` | — |

## References
ADR: `docs/adr/0008-google-login-and-permissions.md`, `0011-access-requests-and-one-time-codes.md`, `0012-gmail-smtp-email-provider.md` · Telas: `docs/design/screens.md` (T9: convite, status e reenvio)

## Open questions
Nenhuma. Premissas: o rótulo do pedido ("Não enviar e-mail") vira a caixa "Não enviar e-mail de convite", desmarcada; o próprio convite conta no limite; uma pessoa aprovada por solicitação (KBC-014) e as convidadas antes desta mudança aparecem como "Ainda não entrou" e podem receber "Enviar convite".

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions
- [x] Fits one goal
