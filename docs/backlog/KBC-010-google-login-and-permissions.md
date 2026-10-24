---
id: KBC-010
title: Login com conta Google e acesso por permissões (funcionalidades e acervos)
status: draft
slice: release-1
outcome: cada pessoa entra com a própria conta e só vê os acervos e funções que recebeu
depends_on: [KBC-007, KBC-008]
---

# KBC-010 — Login com conta Google e acesso por permissões

## Story
Como master, quero que cada pessoa entre com a própria conta Google e só acesse os acervos e as funcionalidades que eu liberar, para compartilhar o app sem expor tudo.

Pedido do dono em 2026-10-24: "Coloque como requisito a necessidade de login (conta do Google) e o acesso às features e acervos de acordo com as permissões dadas"; "Somente um usuário master que deve dar permissão aos acervos e features"; "Usuário master não é único, eu posso dar esse role para qualquer um".

## Scope
**In:**
- **Login obrigatório com Google** (OpenID Connect, "Entrar com Google"), inclusive no uso local. A sessão fica num cookie httpOnly, Secure e SameSite=Lax, e "Sair" está na lateral.
- **Papel master:** quem é master concede e revoga acervos, funcionalidades e o próprio papel de master. O primeiro master vem de configuração (`KB_CHAT_OWNER_EMAIL`), e qualquer master pode tornar outra pessoa master; pode haver vários. Nenhuma outra conta entra sem convite.
- **Tela "Pessoas e permissões"** (só masters):
  - convidar por e-mail;
  - por pessoa, escolher os **acervos** que ela vê e as **funcionalidades**:
    - Buscar documentos;
    - Pesquisa com IA;
    - Montar/ampliar acervo (KBC-009);
    - Configurações de IA próprias;
  - revogar o acesso a qualquer momento.
- **Aplicação das permissões na API, em toda rota:**
  - acervos sem permissão não aparecem na lista;
  - as rotas desses acervos respondem 404;
  - uma funcionalidade sem permissão responde 403 e some da interface.
- **Histórico, preferências, chaves de IA e gasto são por pessoa.** O histórico (KBC-008/C) e as configurações (KBC-007) já são guardados por principal; o login passa a fornecer esse principal.

**Out:**
- Outros provedores de login (e-mail e senha, Microsoft).
- Grupos de pessoas.
- Auditoria detalhada além do log de acesso.

## Business rules
- BR-1: sem sessão válida, a API responde 401 em tudo que não seja login e saúde, e a web leva para "Entrar com Google".
- BR-2: só entram o dono e os e-mails convidados, verificados pelo Google (`email_verified`). Um e-mail não convidado vê "Seu acesso ainda não foi liberado; peça ao dono".
- BR-3: o padrão de um convite novo é "Buscar documentos" em nenhum acervo; um master escolhe os acervos e o resto. Somente masters dão ou tiram permissões, e um master tem acesso a tudo. Sempre resta ao menos um master: o último não pode ser rebaixado nem removido.
- BR-4: revogar um acesso derruba as sessões abertas dessa pessoa em até 1 minuto.
- BR-5: o uso de IA de um convidado conta no teto e no gasto dele. Com assinatura do Claude ou do ChatGPT, só o dono pode usar a própria assinatura (BR-6 do KBC-007).
- BR-6: os dados de cada pessoa (histórico, preferências, chaves) nunca aparecem para outra, nem para o dono, exceto o gasto, que o dono vê por pessoa.

## Functional requirements
- FR-1: `GET /api/v1/auth/google` deve iniciar o fluxo OIDC (state, PKCE e nonce) e `GET /api/v1/auth/google/callback` deve criar a sessão.
- FR-2: `GET /api/v1/me` deve devolver a pessoa, as permissões e os acervos visíveis; a web deve montar a interface a partir disso.
- FR-3: um master deve listar, convidar, alterar (inclusive tornar master) e revogar pessoas em `/api/v1/people`; quem não é master recebe 403.
- FR-4: toda rota de acervo deve verificar a permissão do acervo, e toda rota de funcionalidade deve verificar a permissão da funcionalidade, num guard único, com testes por rota.

## Non-functional requirements
- NFR-1: o login funciona em `http://localhost` (dev) e no domínio hospedado. As credenciais OAuth (client id e secret) ficam no ambiente, nunca no código.
- NFR-2: um teste automatizado percorre todas as rotas registradas e falha se alguma rota de acervo ou de funcionalidade não tiver guard.

## Acceptance criteria
- **AC-1 (BR-1)**
  - Given nenhuma sessão
  - When a web abre
  - Then aparece "Entrar com Google"
  - And a API responde 401 em `/topics`
- **AC-2 (BR-2)**
  - Given um e-mail não convidado
  - When ele entra
  - Then vê "Seu acesso ainda não foi liberado"
- **AC-3 (FR-4)**
  - Given um convidado com o acervo A e "Buscar documentos"
  - When ele abre o app
  - Then vê só o acervo A, a visão "Pesquisa com IA" não aparece e `POST /topics/B/searches` responde 404
- **AC-4 (BR-4)**
  - Given um convidado logado
  - When o dono revoga o acesso
  - Then em até 1 minuto a próxima chamada responde 401
- **AC-5 (BR-6)**
  - Given duas pessoas
  - When cada uma lista o histórico
  - Then cada uma vê só o seu
- **AC-7 (BR-3)**
  - Given dois masters
  - When um rebaixa o outro e depois tenta rebaixar a si mesmo
  - Then o primeiro rebaixamento funciona e o segundo é recusado ("Deve restar ao menos um master")
- **AC-6 (NFR-2)**
  - Given todas as rotas registradas
  - When o teste de cobertura de guards roda
  - Then nenhuma rota de acervo ou funcionalidade está sem guard

## Open questions
- Uso só local hoje: o login também deve ser obrigatório para o próprio dono no Mac, ou só quando hospedado? Padrão adotado: obrigatório sempre (o pedido diz "necessidade de login"). — dono
- Os convidados usam a chave de IA do dono (com teto por pessoa) ou cada um traz a sua? Padrão: cada um traz a sua; o dono pode liberar a dele com teto. — dono

## References
- ADR 0005 (seam de autenticação local), a ser substituída pela ADR 0008 (Google OIDC e permissões).
- KBC-007 (configurações por pessoa), KBC-008 (histórico por principal), KBC-009 (montar acervo: funcionalidade com permissão).
