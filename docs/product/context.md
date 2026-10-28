# Contexto do produto — Nova Alexandria (repositório `kb-chat`)

Registrado no kickoff de 2026-10-23. Fonte: conversa com o dono (Diogo).

## Problema e público

- **Problema:** pesquisar o conhecimento ingerido no `kb` exige o terminal e decorar comandos e flags (`kb search --topic hermetismo --vec`, `kb find --relevance core --min-depth 2`).
- **Para quem:** v1, o próprio dono; release 2, convidados (por exemplo, colegas de estudo do hermetismo).
- **Como resolve hoje:** comandos `kb search` / `kb find` no terminal, ou abrindo os markdown no Obsidian.

## Acervo inicial

- Vault `~/dev/personal/hermetismo`, tópico `hermetismo` (modo wiki), com 4.235 documentos (4.196 fontes e 39 conceitos).
- Facetas disponíveis: genre, relevance (core, adjacent, collected_on_purpose, off_topic, general), depth (0–3), concepts (39), além das relações `example_of`, `extends` e `related`.
- Índice QMD local com busca lexical (BM25), vetorial e híbrida.

## Decisões do dono

| Pergunta | Decisão |
|---|---|
| Como o chat responde | **As duas formas.** A busca gratuita é o padrão; o botão "Responder com IA" (paga, OpenRouter) escreve uma resposta citando as fontes. |
| Onde roda | **Local primeiro, internet depois.** A v1 roda no Mac (localhost); a arquitetura já prevê hospedagem. |
| Acesso na internet | **Convidados com login**, com limite diário de IA por pessoa. |
| Repositório | `~/dev/personal/kb-chat`, genérico para qualquer tópico do kb; o hermetismo é o primeiro. |
| Tipo de MVP | **Ferramenta pessoal útil.** Sucesso: o dono pesquisa pelo navegador toda semana, em vez do terminal. |
| Stack | Angular (frontend), sob o devflow harness. |
| Papéis | O dono decide produto, design e arquitetura e é o único usuário da v1. |

## Fase 2 — acervo de mídia

Decidido em 2026-10-27/28 (conversa com o dono e piloto em `docs/research/2026-10-28-transcription-pilot.md`):

| Pergunta | Decisão |
|---|---|
| O que entra | Áudio e vídeo de palestras: guardar, transcrever, faixas, player com legendas, busca no minuto exato, pesquisa com IA e compilados, coleções, compartilhamento, upload e busca na web, em fases A a E. |
| Volume | Desconhecido; planejado com 500 h e 2.000 h, maioria áudio. |
| Compartilhamento | Só entre usuários do app. |
| Transcrição | No Mac do dono (mlx-whisper turbo, VAD, lista de termos), Groq de reserva com teto (ADR 0023). |
| Gravações ruidosas | Pesquisáveis, com aviso de baixa confiança. |
| Custo | Teto mensal de US$ 10 para a mídia. |
| Originais | Não guardados por padrão; os insubstituíveis, em arquivo frio, depois. |
| Paneas | Só conhecimento; nada de código, servidores ou contas da empresa sem confirmação. |

## Restrições

- **Custo:** créditos da OpenRouter são limitados (o saldo já acabou uma vez); a IA só roda sob pedido explícito, com custo visível.
- **Idiomas:** UI e artefatos em pt-BR; código e docs em inglês.
- **Gerenciador de pacotes:** pnpm.

## Design

Decidido em 2026-10-23:
- **Aparelho:** desktop primeiro (painel do documento ao lado do chat), responsivo no celular. Larguras validadas: 1440 px e 390 px.
- **Visual:** dois temas. **"Claro/Escuro"** (padrão): quente, neutro, inspirado no Claude, sem a marca da Anthropic. **"Esotérico"**, opcional: escuro, com detalhes dourados e serifa clássica. O tema é escolhido num seletor e lembrado no navegador.
- **IA:** botão "Responder com IA" abaixo dos resultados grátis, com custo estimado; a resposta traz citações numeradas que abrem a fonte.
- **Design system:** nenhum existente; criar tokens DTCG próprios (DS-12) com os dois temas.
- **Acessibilidade:** WCAG 2.2 AA. UI em pt-BR.

## Research

Decidido em 2026-10-23: plano em `docs/research/2026-10-23-search-habit.md`. Na v1, o único usuário é o dono. O teste de usabilidade da fase 2 será com 1 a 2 colegas de estudo, recrutados pela rede do dono. Lei aplicável: LGPD. O log de uso fica só local.
