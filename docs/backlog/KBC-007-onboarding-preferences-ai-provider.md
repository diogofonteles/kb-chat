---
id: KBC-007
title: Onboarding com preferências e provedor de IA (chave própria ou assinatura)
status: ready
slice: release-1
outcome: primeira sessão sem configuração manual; IA sem custo por token para quem tem assinatura
depends_on: [KBC-004, KBC-005]
---

# KBC-007 — Onboarding com preferências e provedor de IA

## Story
Ao abrir o kb-chat pela primeira vez, quero escolher minhas preferências e como a IA vai responder (minha chave de API ou minha assinatura do Claude ou do ChatGPT), para usar o app do meu jeito sem editar arquivos nem variáveis de ambiente.

Pedido do dono em 2026-10-24: "no onboarding o usuário deve poder configurar suas preferências, inclusive fornecer sua própria chave de API para sua AI, ou conectar à sua subscrição do Claude ou ChatGPT (sem cobrança por token)".

## Scope
**In:**
- Assistente de primeira abertura, com 4 passos curtos que podem ser pulados: acervo padrão, modo de busca, tema e provedor de IA.
- Tela "Configurações" para alterar tudo depois.
- Provedores de IA:
  - **OpenRouter** (chave);
  - **Anthropic API** (chave);
  - **OpenAI API** (chave);
  - **Assinatura do Claude**, via Claude Code CLI logado (`claude -p`);
  - **Assinatura do ChatGPT**, via Codex CLI logado (`codex exec`);
  - **Nenhum**, só busca.
- Teste de conexão do provedor e teto diário (só para os provedores por token).

**Out:**
- Login e convidados, que entram na release 2.
- Cofre de segredos remoto.
- OAuth próprio com Anthropic ou OpenAI: as assinaturas usam as ferramentas oficiais já logadas no Mac.

## Business rules
- BR-1: as preferências e a chave ficam só no servidor local, em `~/.kb-chat/settings.json` com permissão 0600. A API nunca devolve a chave; mostra só os 4 últimos caracteres.
- BR-2: provedores por token mostram o custo estimado e respeitam o teto diário (ADR 0004). Provedores por assinatura mostram "incluído na sua assinatura", não entram no gasto do dia e não têm teto em US$.
- BR-3: os provedores por assinatura só aparecem como disponíveis quando a ferramenta oficial está instalada e logada (`claude` ou `codex` no PATH, com um teste de conexão bem-sucedido). Sem isso, a opção aparece desabilitada com a instrução de instalação e login.
- BR-4: as variáveis de ambiente (`OPENROUTER_API_KEY` e outras) continuam valendo como padrão quando as configurações não definem um provedor.
- BR-5: o assistente aparece só na primeira abertura, enquanto `settings.json` não existir, e pode ser reaberto em "Configurações".
- BR-7: o kb-chat nunca recebe credencial de assinatura. O login é feito uma vez na ferramenta oficial (`claude` → `/login`, que abre o login da conta claude.ai, com Google ou SSO se a conta for assim; `codex login` → "Sign in with ChatGPT"). O app só chama o CLI já logado (`claude -p` com saída em streaming; `codex exec`). Ao chamar o Claude Code, o servidor remove `ANTHROPIC_API_KEY` do ambiente, para o uso contar na assinatura e não na API.
- BR-6: o uso por assinatura é pessoal e local. Na release 2, hospedada, cada convidado usa a própria chave (ADR 0006).

## Functional requirements
- FR-1: na primeira abertura, a web deve mostrar o assistente. "Pular" deve gravar os padrões.
- FR-2: a API deve expor `GET/PUT /api/v1/settings` (sem segredos na resposta) e `POST /api/v1/settings/ai/test`, que testa o provedor com uma pergunta mínima e diz se funcionou.
- FR-3: a API deve listar os provedores com a disponibilidade de cada um (`GET /api/v1/ai/providers`), detectando `claude` e `codex` no PATH.
- FR-4: com um provedor por assinatura, "Responder com IA" deve usar o CLI oficial em modo não interativo, transmitindo a resposta em streaming, com as mesmas citações e regras de fundamentação do ADR 0004.
- FR-5: trocar de provedor deve valer na próxima resposta, sem reiniciar o servidor.

## Non-functional requirements
- NFR-1: o teste de conexão responde em até 20 s ou mostra "sem resposta do provedor".
- NFR-2: a chave nunca aparece em log, resposta, evidência nem no navegador (teste automatizado).

## Acceptance criteria
- **AC-7 (BR-7)**
  - Given `ANTHROPIC_API_KEY` definido no ambiente do servidor
  - When uma resposta usa a "Assinatura do Claude"
  - Then o processo `claude` é iniciado sem essa variável
- **AC-1 (FR-1, BR-5)**
  - Given nenhum `settings.json`
  - When o app abre
  - Then aparece o assistente
  - And, após "Concluir", ele não volta a aparecer
- **AC-2 (BR-1, NFR-2)**
  - Given uma chave salva
  - When `GET /settings` é chamado
  - Then a resposta traz só `••••abcd`
  - And o arquivo tem permissão 0600
- **AC-3 (BR-3, FR-3)**
  - Given `claude` ausente do PATH
  - When a lista de provedores carrega
  - Then "Assinatura do Claude" aparece desabilitada com a instrução de instalação
- **AC-4 (FR-4, BR-2)**
  - Given o provedor "Assinatura do Claude", com um CLI stub
  - When o usuário pede uma resposta
  - Then o texto chega em streaming com [n]
  - And o botão diz "incluído na sua assinatura"
  - And o gasto do dia não muda
- **AC-5 (FR-2)**
  - Given uma chave inválida
  - When o usuário clica em "Testar conexão"
  - Then aparece "A chave não foi aceita pelo provedor"
- **AC-6 (BR-4)**
  - Given `OPENROUTER_API_KEY` no ambiente e nenhum provedor escolhido
  - When o usuário pede uma resposta
  - Then o OpenRouter é usado

## Test strategy
| AC | Nível |
|---|---|
| AC-2, AC-3, AC-5, AC-6, NFR-2 | Integração da API, com CLIs e HTTP stub |
| AC-1, AC-4 | E2E Playwright, com o provedor stub |

## References
- ADR 0004 (respostas fundamentadas), ADR 0005 (seam de auth) e ADR 0006 (provedores de IA, a escrever junto com este item).
- Telas: `docs/design/screens.md`, seções T4 e T5 (a atualizar com o assistente).

## Open questions
Nenhuma. O dono definiu os provedores; a ressalva da BR-6 vem dos termos das assinaturas pessoais.

## Definition of ready
- [x] Story, scope e outcome
- [x] BR/FR cobertos por AC
- [x] NFRs mensuráveis
- [x] Nível de teste por AC
- [x] Referências
- [x] Dependências agendadas
