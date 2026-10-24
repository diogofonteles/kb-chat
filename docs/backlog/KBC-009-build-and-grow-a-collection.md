---
id: KBC-009
title: Montar ou ampliar um acervo (arquivos locais e pesquisa na web)
status: draft
slice: release-2
outcome: o dono cria e amplia acervos sem usar o terminal
depends_on: [KBC-007]
---

# KBC-009 — Montar ou ampliar um acervo

## Story
Quando quero estudar um assunto novo, ou aprofundar um que já tenho, quero montar um acervo, ou acrescentar material a um existente, pelo próprio app. Isso vale tanto para arquivos que tenho no computador quanto para uma pesquisa na web. Hoje faço isso com `kb` e Firecrawl no terminal.

Pedido do dono em 2026-10-24:
- "o agente de pesquisa de acervo usando o kb e firecrawl deve ser uma feature à parte e não faz parte do chat, essa é uma feature para criar um acervo ou aumentar o acervo existente";
- "pode ser referenciando documentos locais no hd, vídeos, texto, imagens... ou pesquisando na web como o firecrawl faz";
- "essa feature precisa permitir vincular a uma conta do firecrawl e openrouter para permitir sua execução e após esse vínculo, mostrar os saldos disponíveis (e alertar quando estiverem no fim)".

## Scope
**In:**
- Tela própria **"Acervos"**, fora do chat, para:
  - criar um acervo (`kb topic new`);
  - escolher um acervo existente para ampliar.
- **Fontes locais:** pastas e arquivos do computador, com entrada via `kb ingest file` e os conversores do kb:
  - documentos e textos (PDF, DOCX, MD, TXT);
  - imagens, com OCR;
  - vídeos e áudios, com transcrição.
- **Pesquisa na web:**
  - o leitor descreve o que procura;
  - o app busca com Firecrawl e mostra os candidatos (título, site, trecho);
  - o leitor escolhe o que entra, e a entrada é feita via `kb ingest url`;
  - também aceita YouTube, canais e Instagram, como o kb já faz.
- **Depois da ingestão:** classificar, ligar e indexar (`kb classify`, `kb link`, `kb index`), com o progresso visível, e mostrar a fila de revisão (`kb review`) quando houver.
- **Contas vinculadas:** Firecrawl e OpenRouter, com a chave guardada como no KBC-007 (só no servidor local, 0600, mascarada). Com elas:
  - os saldos aparecem na própria tela e em Configurações (créditos da Firecrawl; saldo da OpenRouter = total − uso);
  - aparece um alerta quando um saldo estiver no fim.

**Out:** agendamento de ingestões recorrentes e monitoramento de sites (fica para depois).

## Business rules
- BR-1: sem a conta exigida, a fonte fica desabilitada, com a instrução para vincular:
  - pesquisa na web: Firecrawl + OpenRouter;
  - fontes locais: OpenRouter, que classifica, resume e liga.
- BR-2: antes de rodar, o app mostra a estimativa de custo e o saldo de cada conta, e a ingestão só começa com a confirmação do leitor. O custo real fica registrado.
- BR-3: há alerta de saldo baixo quando a OpenRouter tem menos de US$ 1 ou a Firecrawl tem menos de 100 créditos (os limites podem ser mudados em Configurações). Com saldo insuficiente para a estimativa, a ingestão não começa.
- BR-4: nada é apagado. O que os gates do kb recusam vai para a quarentena e aparece na revisão, como no kb.
- BR-5: só o dono usa esta tela na release 1. Com convidados (release 2), a tela fica restrita ao dono.

## Open questions
- Teto de gasto por ingestão: usar o teto diário do chat ou um teto próprio? — dono
- Pastas locais permitidas: qualquer pasta ou só uma lista configurada (segurança)? — dono

## References
- Skill `kb` (comandos de ingestão, decisão e revisão) e `devflow-core:web-research` (Firecrawl).
- KBC-007 (contas e chaves em Configurações).
