---
id: KBC-014
title: Solicitar acesso, cadastro sem Google e entrada com código por e-mail ou SMS
status: in-review
slice: release-1
outcome: ninguém entra sem aprovação de um master, e quem não usa Google consegue pedir acesso e entrar sem senha
depends_on: [KBC-010]
---

# KBC-014 — Solicitar acesso, cadastro sem Google e entrada com código

## Story
Como alguém que quer usar o kb-chat, quero pedir acesso (com ou sem conta Google) e, depois de aprovado, entrar com um código enviado por e-mail ou SMS, para usar o app sem depender de convite prévio nem de senha.
Como master, quero ver as solicitações pendentes e aprová-las ou recusá-las, para que só entre quem eu liberar.

Pedido do dono em 2026-10-25: "a pessoa que tentar fazer login não deve conseguir entrar se não tiver sido aprovada; teremos uma maneira de convidar o usuario, ou aprovar uma solicitação"; "dar a opção de cadastro do usuario (sem usar SSO do google): email, nome e sobrenome, celular; quando o user fizer login, receberá um codigo por email ou SMS; usando serviços gratuitos".

## Scope
**In:**
- **Pedir acesso sem Google:** formulário com e-mail, nome, sobrenome e celular. Um código de 6 dígitos enviado por e-mail confirma o e-mail; só então nasce a solicitação pendente.
- **Pedir acesso com Google:** a tela "Seu acesso ainda não foi liberado" ganha "Solicitar acesso", com celular opcional, usando a identidade Google já verificada.
- **Solicitações pendentes** em Pessoas e permissões (só masters): Aprovar e Recusar; selo com a contagem na lateral; e-mail aos masters a cada nova solicitação e ao solicitante quando aprovado.
- **Entrar com código:** quem está em Pessoas e permissões digita o e-mail (ou o celular, quando o SMS estiver ligado) e recebe um código de 6 dígitos; a sessão é a mesma do Google (KBC-010).
- **Envio:** e-mail pelo Resend (camada gratuita); SMS atrás de uma porta, desligado enquanto o dono não escolher um provedor (ADR 0011).

**Out:**
- Um provedor de SMS real (nenhum é gratuito em produção no Brasil; ADR 0011).
- WhatsApp e Telegram como canais de código.
- Editar nome ou celular depois de aprovado; trocar o e-mail de uma pessoa.
- Painel de auditoria das solicitações além do log.

## Business rules
- BR-1: ninguém recebe sessão sem estar em Pessoas e permissões (convidado por um master, aprovado por um master ou o dono). Uma solicitação pendente ou recusada não dá acesso a nada.
- BR-2: o cadastro sem Google só vira solicitação depois que o código do e-mail é confirmado.
- BR-3: as respostas de envio de código e de cadastro nunca revelam se um e-mail ou celular já existe, está pendente ou foi recusado ("Se o e-mail puder ser usado, enviamos um código."). Exceção: no Google, a identidade já é da própria pessoa, então a tela diz se a solicitação dela está em análise ou recusada.
- BR-4: um código vale 10 minutos, serve uma vez e aceita no máximo 5 tentativas; depois disso é descartado. Pedir um código novo descarta o anterior do mesmo identificador.
- BR-5: o envio de código é limitado a 1 por minuto e 5 por hora por e-mail ou celular (contados à parte para cadastro e para entrada), e a 5 por minuto e 20 por hora por endereço de rede.
- BR-6: aprovar cria a pessoa com os padrões do convite (BR-3 do KBC-010: "Buscar documentos" em nenhum acervo); o master escolhe o resto no editor que abre em seguida.
- BR-7: quem foi recusado só pode pedir de novo 24 horas depois da recusa.
- BR-8: o celular é guardado no formato E.164; sem código de país, vale o do Brasil (+55).
- BR-9: o SMS só aparece como opção quando há um provedor de SMS configurado.

## Functional requirements
- FR-1: `POST /api/v1/access-requests/signup` deve receber e-mail, nome, sobrenome e celular, responder 202 sempre e, se o e-mail puder ser usado, enviar um código de confirmação por e-mail. (BR-2, BR-3, BR-5, BR-8)
- FR-2: `POST /api/v1/access-requests/signup/verify` deve, com o código certo, criar a solicitação pendente e avisar os masters por e-mail. (BR-2, BR-4)
- FR-3: `POST /api/v1/auth/google` com uma conta não convidada deve responder `NOT_INVITED` com um ticket de solicitação assinado (15 min, uso único) e a situação da solicitação; `POST /api/v1/access-requests/google` deve criar a solicitação com o ticket e o celular opcional. (BR-1, BR-7)
- FR-4: `GET /api/v1/access-requests`, `POST /api/v1/access-requests/:id/approve` e `POST /api/v1/access-requests/:id/refuse` devem listar, aprovar e recusar, só para masters; aprovar avisa o solicitante por e-mail. (BR-6, BR-7)
- FR-5: `POST /api/v1/auth/code` deve responder 202 sempre e enviar o código a quem está em Pessoas e permissões; `POST /api/v1/auth/code/verify` deve abrir a sessão com o código certo. (BR-1, BR-3, BR-4, BR-5)
- FR-6: `GET /api/v1/auth/config` deve informar os canais de código disponíveis (`email`, `sms`). (BR-9)
- FR-7: a API deve recusar subir em produção (`NODE_ENV=production`) sem `RESEND_API_KEY` ou com o SMS de log.

## Non-functional requirements
- NFR-1: o código é guardado só como hash (scrypt com sal por código) e comparado em tempo constante; nenhum código aparece em log em produção.
- NFR-2: o teste de cobertura de rotas (KBC-010 NFR-2) inclui as rotas novas e a lista de rotas públicas declarada.
- NFR-3: as respostas de envio e cadastro têm o mesmo status e corpo em todos os casos, e o envio acontece depois da resposta (sem diferença de tempo por caso).

## Acceptance criteria
- **AC-1 (FR-1, FR-2, BR-2)**
  - Given um e-mail que não está no app
  - When a pessoa preenche o cadastro e confirma o código recebido por e-mail
  - Then aparece "Solicitação enviada" e a solicitação aparece pendente para os masters, que recebem um e-mail
- **AC-2 (BR-3)**
  - Given um e-mail já em Pessoas e permissões, outro pendente e outro desconhecido
  - When cada um pede código de cadastro ou de entrada
  - Then as três respostas são 202 com o mesmo corpo
- **AC-3 (BR-1)**
  - Given uma solicitação pendente
  - When a pessoa pede um código de entrada
  - Then nenhum código de entrada é enviado e nenhuma sessão é aberta
- **AC-4 (FR-4, BR-6)**
  - Given uma solicitação pendente
  - When um master clica em Aprovar
  - Then a pessoa entra na lista com "Buscar documentos" e nenhum acervo, o editor dela abre, e ela recebe um e-mail
- **AC-5 (FR-5)**
  - Given uma pessoa aprovada sem Google
  - When ela pede o código pelo e-mail e digita o código certo
  - Then entra no app com a mesma sessão do Google
- **AC-6 (BR-4)**
  - Given um código enviado
  - When passam 10 minutos, ou ele já foi usado, ou erraram 5 vezes
  - Then o código certo é recusado com "Esse código não confere ou já venceu. Confira os 6 dígitos ou peça um novo."
- **AC-7 (BR-5)**
  - Given um código enviado agora para um e-mail
  - When pedem outro para o mesmo e-mail no mesmo minuto
  - Then nenhum segundo código é enviado
- **AC-8 (FR-3)**
  - Given uma conta Google não convidada
  - When ela clica em "Solicitar acesso" e envia
  - Then a solicitação fica pendente com o e-mail verificado do Google, e reenviar o mesmo ticket é recusado
- **AC-9 (BR-7)**
  - Given uma solicitação recusada há menos de 24 h
  - When a mesma pessoa pede de novo
  - Then não nasce solicitação nova; depois de 24 h, nasce
- **AC-10 (FR-4, permissão)**
  - Given alguém que não é master
  - When chama as rotas de solicitações
  - Then recebe 403
- **AC-11 (BR-8)**
  - Given o celular "(81) 99999-0000"
  - When o cadastro é enviado
  - Then ele é guardado como "+5581999990000"; um celular inválido é recusado no campo
- **AC-12 (BR-9, FR-6)**
  - Given nenhum provedor de SMS
  - When a tela de entrada abre
  - Then só aparece a opção de e-mail
- **AC-13 (FR-7)**
  - Given `NODE_ENV=production` sem `RESEND_API_KEY`
  - When a API sobe
  - Then ela para com a mensagem do que falta
- **AC-14 (NFR-2)**
  - Given todas as rotas registradas
  - When o teste de cobertura roda
  - Then as rotas novas têm acesso declarado e as públicas estão na lista

## Test strategy
| AC | Level | Notes |
|---|---|---|
| AC-1 | integração (API) + E2E | caixa de saída em memória; E2E lê o código por `/api/e2e/outbox` |
| AC-2 | integração (API) | compara status e corpo dos três casos |
| AC-3 | integração (API) | caixa de saída vazia, `/me` 401 |
| AC-4 | integração (API) + E2E | o E2E aprova pela tela |
| AC-5 | integração (API) + E2E | |
| AC-6 | unitário (serviço de códigos) | relógio injetado |
| AC-7 | unitário (limitador) + integração | |
| AC-8 | integração (API) + E2E | identidade de teste do E2E (KBC-010) |
| AC-9 | unitário (regras) + E2E (recusa) | relógio injetado |
| AC-10 | integração (API) | |
| AC-11 | unitário (contracts) + componente (web) | |
| AC-12 | componente (web) | |
| AC-13 | unitário (config) | |
| AC-14 | integração (route-access.test.ts) | |

## References
Telas: `docs/design/screens.md` (T8, T9 e T10) · ADR: `docs/adr/0008-google-login-and-permissions.md`, `docs/adr/0011-access-requests-and-one-time-codes.md` · Contratos: `libs/contracts/src/access.ts`

## Open questions
- Qual provedor de SMS usar (todos cobram por mensagem no Brasil)? — dono. Não bloqueia: o SMS sai desligado (BR-9).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable or explicitly none
- [x] Test level chosen for every AC
- [x] UI and architecture references linked when they apply
- [x] Dependencies done or scheduled; no open questions (a do SMS não bloqueia)
- [x] Fits one goal
