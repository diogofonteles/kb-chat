# Telas e fluxos — Nova Alexandria (esqueleto, release 1 e fase 2)

Fonte: `docs/product/vision.md`, `docs/product/brief.md`, `docs/product/context.md` (## Design). Facetas reais do tópico `hermetismo` (`kb find --facets`, 2026-10-23).

## Vocabulário da interface (UP-03, DS-18)

Nenhum termo interno do kb aparece na tela. O mapa abaixo é a fonte única para código, i18n e testes.

| kb | Na tela | Valores |
|---|---|---|
| topic | **Acervo** | título do tópico (`kb topic list`), ex.: "Hermetismo" |
| search mode híbrido / `--lex` / `--vec` | **Como buscar**: "Tudo" (padrão) / "Palavras exatas" / "Por significado" | ajuda curta (UP-12): "Palavras exatas acha o termo como você escreveu; Por significado acha ideias parecidas, mesmo com outras palavras." |
| relevance | **Ligação com o tema** | core → "Central"; adjacent → "Relacionado"; collected_on_purpose → "Material de estudo"; off_topic → "Fora do tema"; general → "Geral" |
| genre | **Tipo de texto** | article_or_essay → "Texto/apostila"; talk_or_interview → "Aula ou palestra"; tutorial_or_guide → "Guia prático"; reference_docs → "Referência"; paper → "Estudo acadêmico"; announcement_or_news → "Aviso"; other → "Outros" |
| depth | **Profundidade** | 0 → "Introdutório"; 1 → "Intermediário"; 2 → "Aprofundado"; 3 → "Avançado" |
| concepts | **Assuntos** | nome do conceito sem caminho (normalizar `hermetismo/wiki/concepts/Cabala` → "Cabala") |
| example_of / extends / related | **Veja também**: "É exemplo de" / "Aprofunda" / "Relacionados" | |
| `kb find` + modelo | **Responder com IA** | |

Os valores com 0 documentos no acervo atual não aparecem como chips (SL-16): por exemplo, depth 3 e quarantined.

## Layout geral

```
Desktop (≥ 1024 px)                                   Celular (< 1024 px)
┌──────────┬───────────────────────────┬──────────┐   ┌────────────────────┐
│ Lateral  │ Conversa (coluna 720 px)  │ Documento│   │ ☰  Acervo ▾   ◐    │
│ + Nova   │  pergunta (balão)         │ (painel, │   │ conversa           │
│ histórico│  ┌ resultados ──────────┐ │ abre ao  │   │ ...                │
│ da sessão│  │ chips de filtro      │ │ clicar)  │   │ [caixa de pergunta]│
│          │  │ cartões              │ │          │   └────────────────────┘
│ Acervo ▾ │  │ [Responder com IA]   │ │          │   Documento = tela cheia
│ Tema ◐   │  └──────────────────────┘ │          │   com "← Voltar" (UP-04)
│          │ [caixa de pergunta fixa]  │          │
└──────────┴───────────────────────────┴──────────┘
```

O ⚙ **Configurações** fica no pé da lateral e do menu do celular (T6).

Hierarquia (UP-16), em ordem: (1) caixa de pergunta, (2) cartões de resultado, (3) chips de filtro, (4) botão de IA. A busca é a navegação principal, por isso o campo fica fixo e sempre visível (SL-03).

---

## T1. Início (estado vazio da conversa)

**Objetivo do usuário:** fazer a primeira pergunta sem precisar saber nada do kb. **Contexto:** estudo em casa, sem pressa, no desktop. **Sucesso:** a primeira busca sai em 1 passo (digitar e Enter).

### Fluxo
1. Abre o app → saudação "O que você quer estudar hoje?" + caixa de pergunta em foco + o acervo atual ("Hermetismo · 4.235 documentos").
2. Abaixo, 4 a 6 sugestões clicáveis, tiradas dos 6 maiores **Assuntos** (ex.: "Cabala", "Corpos Sutis e Energia"). O clique busca o assunto já filtrado por ele (UP-12: ajuda em contexto, sem tutorial).

### Caixa de pergunta (SL-01, SL-04 a SL-07)
- Campo multilinha com rótulo acessível "Sua pergunta" e um placeholder de exemplo ("ex.: o que é a natureza sétupla?"); o placeholder não é o único rótulo (SL-04).
- Botão enviar à direita, com contraste (SL-05); Enter envia e Shift+Enter quebra a linha.
- "×" para limpar quando há texto (SL-06).
- Seletor compacto **Como buscar** à esquerda do botão: "Tudo ▾". É um menu com 3 opções e a ajuda de uma linha de cada (UP-15). Ele lembra a última escolha.
- Sem autocomplete na R1 (SL-10/11 ficam para depois: o acervo não tem consultas registradas).

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Vazio | Saudação, sugestões, contagem do acervo | Digitar, clicar numa sugestão |
| Carregando o acervo | Esqueleto da contagem | — |
| Erro: backend fora do ar | "Não consegui falar com o servidor de busca. Verifique se ele está rodando (`pnpm dev`)." (UP-11) | "Tentar de novo" |
| Erro: acervo sem índice | "Este acervo ainda não tem índice de busca. Rode `kb index --topic <slug>` no terminal." | "Tentar de novo" |
| Nenhum acervo encontrado | "Nenhum acervo kb encontrado em <vault>." + caminho configurado | — |

---

## T2. Resultados de uma pergunta (mensagem do sistema na conversa)

**Objetivo:** reconhecer em segundos qual documento abrir. **Sucesso:** abrir o documento certo sem abrir outros antes (≥ 50% das buscas abrem um documento, conforme o brief).

### Fluxo
1. Envia → a pergunta aparece como balão do usuário → mensagem "Buscando no Hermetismo…" com progresso em menos de 400 ms (UP-14).
2. Chega a resposta: linha de resumo ("23 documentos · Tudo · 0,6 s"), chips de filtro, até 10 cartões e "Mostrar mais".
3. Clique no cartão → abre T3 (painel). O cartão aberto fica marcado.
4. Clique num chip → a busca se refaz **na mesma mensagem** (não cria nova mensagem). A pergunta fica editável com o lápis no balão (SL-07).

### Cartão de resultado (SL-17, DS-06)
```
┌────────────────────────────────────────────────────────┐
│ A Natureza Sétupla                         (+2 cópias) │  título, até 2 linhas
│ "…está contido na Escala Sétupla. Todas as manifes-    │  trecho de 3 linhas, termos
│ tações vibratórias compreendem a setuplicidade…"       │  da busca em <mark>
│ Aula ou palestra · Intermediário · Central             │  facetas em texto (não só cor, UP-20)
│ Assuntos: Cosmologia Espiritual · Hermetismo  (+1)     │
└────────────────────────────────────────────────────────┘
```
- O trecho nunca mostra frontmatter. Quando o trecho do QMD cai no cabeçalho YAML, usar o `summary` do documento.
- **Cópias quase iguais** (mesmo título normalizado, ex.: `a-natureza-s-tupla-2` e `-5`) viram **um cartão** com "+2 cópias", que expande. A pontuação é a da melhor cópia. Evita a lista repetida (SL-25).
- A pontuação não aparece como número. A ordem já comunica a relevância.
- O cartão inteiro é o alvo de clique, com no mínimo 44 px de altura e foco visível.

### Chips de filtro (SL-13, SL-15, SL-16, UP-15)
- Linha de chips acima dos cartões: **Assuntos ▾ · Tipo de texto ▾ · Profundidade ▾ · Ligação com o tema ▾**. Cada um abre um popover de múltipla escolha com contagens ("Cabala (455)").
- As contagens refletem os resultados da busca atual quando possível. Senão, o acervo inteiro, rotulado como "no acervo".
- Chip ativo: preenchido, com "×" para remover e o texto "Profundidade: Aprofundado" (estado em texto, não só em cor, UP-20).
- Padrão sensato (UP-06): **"Fora do tema" fica oculto por padrão**. Aparece no chip como uma opção desmarcada, com a nota "11 ocultos", e uma marcação os mostra (honesto: nada é escondido em silêncio, SL-24).
- No celular, os chips rolam na horizontal **e** "Filtros (2)" abre uma tela cheia com "Aplicar" fixo e "Cancelar" (SL-21). Nada depende de hover (SL-22).

### Autoria (KBC-020)
- Antes dos chips, o controle segmentado **"Autoria: Todos (120) · ✦ Mestre Laércio (80) · Outros autores (40)"**: um grupo de rádio (MA-19), com a escolha aplicada na hora na mesma mensagem. O segmento escolhido fica preenchido e com "✓" (estado em texto e forma, não só cor, UP-20). "Todos" é o padrão e inclui as sínteses do acervo e os não classificados. Uma opção com 0 resultados fica desabilitada, salvo se já estiver escolhida. No celular, o controle ocupa uma linha própria acima dos chips, com os três segmentos lado a lado (o de "✦ Mestre Laércio", o rótulo mais longo, um pouco mais largo) e sem rolagem horizontal.
- **Selo de autoria** na primeira linha de cada cartão, antes do título: **"✦ Mestre Laércio"** em pílula cheia (acento), **"Outros autores"** em pílula contornada, **"Síntese do acervo"** em contorno tracejado e **"Não classificado"** em contorno pontilhado e texto discreto. Leitores de tela ouvem "Autoria: …". Um documento sem autoria (dado antigo) não mostra selo.

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Carregando | 3 cartões-esqueleto + "Buscando…" (> 400 ms) | "Cancelar" |
| Lento (> 5 s, modo Tudo) | "A busca completa está demorando. 'Palavras exatas' é mais rápida." | Trocar o modo com 1 clique |
| Sem resultados (SL-14) | "Nada encontrado para "<q>" com estes filtros." + sugestões: remover o último filtro, trocar para "Por significado", conferir a ortografia | Botões para cada sugestão |
| Sucesso | Resumo + chips + cartões | Abrir, filtrar, Mostrar mais, IA |
| Muitos resultados | 10 por vez; "Mostrar mais (até 50)" | — |
| Título ou trecho enormes | O título trunca em 2 linhas com o completo no `title`/painel; o trecho trunca em 3 linhas | — |
| Erro na busca | "A busca falhou: <motivo simples>." + "Tentar de novo" (preserva pergunta e filtros, MA-26) | Tentar de novo |

---

## T3. Painel do documento

**Objetivo:** ler a fonte com o trecho encontrado em destaque e seguir para documentos ligados. **Sucesso:** ver o trecho sem rolar à procura dele.

### Fluxo
1. O painel abre à direita (desktop) ou em tela cheia (celular) → título, facetas e **Assuntos** como chips (o clique filtra a conversa por aquele assunto).
2. O corpo é o markdown renderizado (sem frontmatter), em tipografia de leitura (serifada, 65–75 caracteres por linha). O texto rola até o primeiro trecho encontrado, destacado; "1 de 4 ocorrências ▲▼".
3. **Resumo** (o campo `summary` do kb) recolhível no topo.
4. **Veja também**: grupos "É exemplo de", "Aprofunda" e "Relacionados", cada um com até 5 links, que abrem no mesmo painel e mantêm um "← Voltar" (UP-04).
5. Ações: "Copiar trecho" e "Abrir no Obsidian" (link `obsidian://`) (UP-13).

### Estados
| Estado | Mostra |
|---|---|
| Carregando | Título já visível (veio do cartão) + esqueleto do corpo |
| Documento sumiu / foi para a quarentena | "Este documento não está mais no acervo (foi removido ou movido para a quarentena)." |
| Sem relações | A seção "Veja também" não aparece (UP-10) |
| Documento muito longo (> 200 KB) | Renderização progressiva e índice de seções quando houver títulos |
| Transcrição de áudio ou OCR | Selo "Transcrição automática" ou "Texto extraído de imagem (OCR)", que avisa sobre erros de reconhecimento (UP-02) |
| Autoria (KBC-020) | O selo de autoria (o mesmo do cartão) abre a área de metadados; quando o vault informa o autor, ele aparece ao lado ("✦ Mestre Laércio · José Laércio do Egito") |

---

## T4. Pesquisa com IA (KBC-008)

*Emenda 2026-10-24: substitui o botão "Responder com IA · ~US$ 0,01" do KBC-004, que nunca disparava sozinho (KBC-008 BR-5).*

**Objetivo:** perguntar como num chat com o Claude e receber uma resposta pesquisada em todo o acervo, que continua o assunto das perguntas anteriores. **Sucesso:** toda afirmação do acervo tem uma citação `[n]` clicável, e o custo (ou "Incluído na sua assinatura") aparece ao final.

### Fluxo
1. O seletor fixo no topo, **"Buscar documentos | Pesquisa com IA"**, escolhe a visão. Com um provedor, a visão inicial é "Pesquisa com IA" (ou a padrão de Configurações); sem provedor, "Pesquisa com IA" fica desabilitada, com a explicação.
2. Na tela inicial, a saudação "O que você quer pesquisar no acervo?" e a caixa de pergunta ficam centralizadas juntas. Em janelas baixas, a saudação nunca fica sob a barra superior: a área dela rola.
3. Perguntar já pesquisa com IA. Na caixa de pergunta, um seletor segmentado **"Rápido | Profundo | Exaustivo"** (três rádios, MA-19) escolhe o perfil, com uma linha de ajuda ("Responde em segundos, com uma pesquisa curta e uma resposta direta." / "Pesquisa mais e usa o modelo mais forte; pode levar um minuto." / "Varre o acervo inteiro, página por página, e lista tudo o que achar; pode levar vários minutos."). No Exaustivo (KBC-017, KBC-030, ADR 0021) a IA só planeja; o aplicativo varre o conjunto em lotes. Antes do primeiro lote, um quadro "Varredura do conjunto inteiro" mostra a estimativa ("2.555 documentos em ~160 lotes (~162 pedidos à IA). Leva pelo menos ~9 min." com modelo gratuito, mais "Modelos gratuitos são menos rigorosos e mais lentos."; com modelo pago, "Custo de no máximo US$ x, dentro do seu teto diário."), depois uma barra "Progresso da varredura" com "Lote 12 de 80 · a IA analisou 412 de 1.363 documentos" (texto em `role="status"`); o quadro some quando a resposta começa. Abaixo da resposta, a cobertura medida pelo aplicativo, uma palavra por contagem: "Cobertura (medida pelo aplicativo): 2.555 documentos no conjunto · 2.555 conferidos pelas expressões · 1.363 com ocorrências · 412 analisados pela IA." (sem expressões: "… · 22 lidos por inteiro pela IA"; numa continuação, "(somando as varreduras anteriores)"), e "Conjunto: autoria Mestre Laércio; expressões: livro, obra"; o resumo dos passos termina com "· a IA analisou 412 de 1.363 documentos". Se um limite parou a varredura (tempo, pedidos, gasto do dia, provedor) ou o leitor clicou em Parar, "Varredura incompleta. Faltaram N documentos para a IA analisar: <motivo>." com uma borda de destaque e, logo abaixo, o botão principal **Continuar varredura** no último turno (também numa conversa reaberta do histórico), no lugar de "Tentar de novo"; ele aparece como "Continuar varredura: <pergunta>" e varre só o que faltou. Se a varredura terminou mas o teto do dia impediu a resposta: "A varredura terminou, mas a resposta não foi escrita: o teto de gasto do dia chegou." com o mesmo botão. O custo aparece como nos outros perfis ("Incluído na sua assinatura" ou "Custo: …"). O padrão vem de Configurações; o navegador lembra a última escolha (KBC-011). No celular, a ajuda fica só para leitores de tela.
4. Uma linha discreta mostra o passo atual ("Buscando “ritmo”", "Lendo “Os Princípios”") e, ao final, o resumo ("Pesquisou 2 vezes · leu 3 documentos"), que se expande. "Parar" fica visível enquanto o agente trabalha.
5. A resposta aparece assim que o modelo começa a escrever (ADR 0009). Se um texto já mostrado era o agente pensando alto antes de usar uma ferramenta, ele sai da resposta e fica na lista de passos como **"Pensando: …"**, em itálico e mais discreto, para o leitor entender por que o texto sumiu (UP-01). A resposta chega em streaming abaixo da pergunta.
   - Quando a pesquisa Rápida não basta, a linha de passos mostra **"Aprofundando a pesquisa…"** e a mesma resposta continua no perfil Profundo; ao final, o resumo diz "… · aprofundou a pesquisa" (ADR 0009). `[n]` abre o painel no documento; abaixo, "Fontes" lista só os documentos citados, como chips numerados. Tabelas largas rolam na horizontal dentro da resposta.
6. As perguntas seguintes levam as anteriores como contexto e aparecem abaixo, como no Claude.

### Regras de conteúdo
- A IA pesquisa antes de responder e nunca pede ao leitor para refazer a busca. Conhecimento de fora do acervo vem marcado "(fora do acervo)".
- Rodapé fixo: "Resposta gerada por IA a partir do acervo; confira nas fontes." com "Custo: US$ 0,008" ou "Incluído na sua assinatura".
- **Autoria (KBC-020):** a IA nunca atribui ao Mestre Laércio o que está em documentos de outros autores e rotula as citações de outros autores com o autor ou o livro. Em "Fontes", cada chip leva o selo de autoria; quando as fontes citadas misturam grupos, elas aparecem em grupos com subtítulo ("Mestre Laércio (3)", "Outros autores (2)", "Síntese do acervo", "Não classificado"), nessa ordem. Respostas salvas antes do KBC-020 mostram as fontes como antes, sem selo.

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Sem provedor (ou "Nenhum" salvo em Configurações, na hora) | "Pesquisa com IA" desabilitada no seletor, com a explicação; a tela volta para "Buscar documentos" | — |
| Saldo insuficiente (HTTP 402) | "Os créditos da OpenRouter acabaram…" (tom sério, DS-19) | Adicionar créditos · Tentar de novo |
| Teto diário atingido | "Limite de gasto com IA de hoje atingido. Ele volta a zero à meia-noite; o valor se ajusta em ⚙ Configurações." | Abrir Configurações (sem "Tentar de novo") |
| Chave recusada, CLI sem login, provedor fora | A mensagem do caso, com o que fazer (⚙ Configurações ou o login no terminal) | Tentar de novo |
| Erro do modelo ou timeout | "Não consegui gerar a resposta agora." | Tentar de novo |
| Interrompida | Texto parcial + "(interrompida)" e o aviso de custo parcial; antes do primeiro texto, "Resposta interrompida antes de começar." sem aviso de custo. Fica no histórico nos dois casos. | Tentar de novo |
| Recarregada no meio (KBC-029) | A conversa volta sozinha (mesma aba), com a pergunta e "Parar"; a resposta continua chegando, do começo, e termina como de costume. Fechar a aba ou abrir outra conversa não para a pesquisa: ela termina e entra no histórico. Só "Parar" para. | Parar |
| Aberta do histórico depois de falhar ou parar (KBC-029) | O turno como ficou ("Não consegui gerar a resposta agora.", "(interrompida)") | Tentar de novo (pergunta de novo no lugar) |

---

### Rodapé da resposta e recusas (KBC-022)
- Rodapé: "Respondido por <modelo que respondeu> · Gratuito · Pesquisas restantes hoje: N" (plano da casa) ou "· Custo: US$ …".
- Cota esgotada: "Suas pesquisas com IA de hoje acabaram (N por dia). Volte amanhã ou conecte a sua própria IA." + botão "Conectar a minha IA" (⚙ > IA).
- Capacidade gratuita esgotada: "A IA gratuita da aplicação está sem capacidade agora. Tente mais tarde ou conecte a sua própria IA." + o mesmo botão.

## T5. Lateral: conversa, histórico, acervo e tema

- **+ Nova conversa** e o **histórico completo**, guardado pela API local neste computador e rotulado "salvo no servidor": todas as conversas das duas visões, sem limite (KBC-005 BR-1, emenda 2026-10-24). Restaurar uma conversa com IA mostra as respostas salvas sem chamar a IA.
- Uma conversa que ainda não chegou à API fica guardada no navegador e é reenviada sozinha; enquanto isso, a lateral avisa "Ainda não consegui salvar uma conversa no histórico…".
- **Desde o envio (KBC-029):** a conversa entra no topo do histórico, selecionada, no instante em que a pergunta é enviada (busca e pesquisa com IA; título = a primeira pergunta). A linha de meta diz como ela está, sempre em texto (nunca só cor): "· pesquisando…" com um pequeno spinner (parado com `prefers-reduced-motion`), "· interrompida" ou "· falhou" (cor de perigo). Uma pesquisa que roda no servidor e não está na tela é conferida a cada 5 s até terminar; um turno que o servidor não roda mais aparece como "interrompida", nunca com spinner para sempre.
- **Acervo ▾**: lista de `kb topic list` com a contagem de documentos. Trocar de acervo inicia uma conversa nova (aviso inline, sem modal).
- **Tema**: "Automático (claro/escuro)" · "Claro" · "Escuro" · "Esotérico", lembrado no navegador.
- **Gasto com IA hoje: US$ 0,03 de US$ 1,00** (UP-02).

## T6. Configurações (KBC-007)

**Objetivo:** trocar quem responde (assinatura ou chave própria) e as preferências sem editar arquivos. **Sucesso:** trocar de provedor e ver a próxima resposta usar o novo, sem reiniciar.

- Aberta pelo **⚙ Configurações**, fixo no pé da lateral (desktop) e do menu (celular). Abre como diálogo modal sobre a conversa, que continua igual ao fechar (FR-6). No celular, ocupa a tela inteira.
- Seções à esquerda (no celular, abas no topo): **IA · Preferências · Sobre**. O foco começa no título; Esc e × fecham.
- **IA:** cartões de rádio, nesta ordem: Assinatura do Claude, Anthropic API, OpenRouter, Assinatura do ChatGPT, OpenAI API, Nenhum. Cada cartão mostra o custo em texto ("Incluído na sua assinatura" ou "Cobra por uso · chave própria"). Uma assinatura sem a ferramenta instalada aparece desabilitada, com "Não instalado." e o passo a passo de instalação e login (BR-3). No servidor (KBC-031), a Assinatura do ChatGPT bloqueada diz o motivo real: "Desativado." + "Ligue em ⚙ Configurações → IA da aplicação → “Ligar a assinatura do ChatGPT (Codex)”." · "Sem login no servidor." + "Entre no servidor por SSH, rode codex login --device-auth (runbook, passo 9c) e reabra esta tela." · "Indisponível no servidor." + "O contêiner do Codex não está configurado ou não respondeu…"; o texto de `KB_CHAT_CODEX=on` só aparece no computador do dono.
  - Provedor por uso: o campo da chave é só de escrita. Uma chave salva aparece como "Chave salva ••••abcd" com "Remover" (BR-1). Uma chave do servidor (variável de ambiente) é avisada.
  - **Modelo rápido** e **Modelo profundo** (KBC-011): um para cada perfil da pesquisa. Nas assinaturas, uma lista fechada ("Padrão: sonnet", `opus`, `haiku`…); nos provedores por uso, texto livre com sugestões. Vazio usa o padrão, mostrado na primeira opção ou no placeholder. Cada provedor guarda os seus.
  - Limite de gasto por dia (US$), só para os provedores por uso.
  - "Testar conexão" responde em até 20 s, numa linha de status (NFR-1, AC-5).
  - "Salvar" grava provedor, chave, modelo e limite juntos.
- **Preferências:** tela inicial (Pesquisa com IA ou Buscar documentos), pesquisa com IA por padrão (Rápido, Profundo ou Exaustivo), **Aprofundar automaticamente** (caixa de seleção, ligada por padrão, com uma linha de ajuda), acervo padrão, modo de busca e tema. Salvam ao mudar ("Salvo automaticamente.").
- **Sua IA** (KBC-023): a seção IA vira um guia. No topo, o cartão "Quem atende você agora" (IA ativa, quem paga, "Último teste: funcionando (dd/mm hh:mm)" ou o erro, e o uso de hoje: pesquisas restantes, "Gratuito" ou "Gasto hoje: US$ x de US$ y"). Depois, um cartão por opção, nesta ordem: **IA da aplicação** (voltar a ela), **OpenRouter** ("Conectar OpenRouter" em um clique ou colar a chave; "Só modelos gratuitos (recomendado)" ou "Modelo à escolha"; reserva paga opcional dentro do limite diário), **Gemini (gratuito)** (passos no Google AI Studio, colar a chave, plano Gratuito/Pago, aviso de privacidade), **Claude (API da Anthropic)**, **OpenAI (API)** e, só para o dono, as assinaturas. Cada cartão aberto mostra passos numerados, "Quanto custa", "Privacidade", "Limites" e links que abrem em nova aba ("(abre em nova aba)" no nome acessível). Claude e OpenAI avisam: "Assinaturas (Claude Pro/Max, ChatGPT Plus/Pro) não podem ser conectadas por outros apps; use uma chave de API."
- **Assinatura cedida** (KBC-024): quando a IA da aplicação que atende a pessoa é a assinatura do Claude do administrador, o cartão "Quem atende você agora" diz "IA da aplicação · Incluído na assinatura do administrador · Pesquisas restantes hoje: N de M" e mostra em destaque "Você está usando temporariamente a IA da aplicação (assinatura do Claude do administrador)." e, para quem tem "Configurações de IA próprias", o botão "Configurar a minha IA", que leva o foco à primeira opção de IA própria. Quem não tem essa permissão vê o mesmo cartão, sem o botão, no topo de Preferências.
- **Quem atende você** (KBC-022), no topo da seção IA: "IA da aplicação (cedida pelo administrador) · Plano da casa · Gratuito · Pesquisas restantes hoje: 3 de 5" ou "Sua IA · OpenRouter · você paga". O cartão "IA da aplicação" fica no topo da lista de provedores.
- **Sobre:** onde ficam os dados (~/.kb-chat, só o seu usuário lê); a assinatura nunca passa a senha à Nova Alexandria; "Rever o assistente de início".

| Estado | Mostra |
|---|---|
| Carregando | "Carregando…" e "Verificando o que está disponível…" |
| Servidor fora | "Não consegui carregar as configurações…" + "Tentar de novo" |
| Erro ao salvar | "Não consegui salvar. Tente de novo." (o rascunho continua na tela) |

## T7. Assistente de primeira abertura (KBC-007)

- Preferências iniciais do convite (KBC-028): o assistente abre já com as preferências que o master definiu no convite (acervo, visão, perfil de pesquisa, tema); a pessoa pode mudar tudo.

- Aparece sozinho enquanto não há configuração salva para o usuário (BR-5). Cada passo pode ser pulado:
  1. Como a IA vai responder? A Assinatura do Claude vem selecionada quando o Claude Code está instalado (BR-4).
  2. Por onde começar? (tela inicial e modo de busca)
  3. Qual acervo você estuda?
  4. Escolha o tema.
- Rodapé fixo: "Pular" (grava os padrões e não volta, FR-1), "Voltar", "Continuar" e "Concluir".
- "Passo n de 4" no topo. Reabre em Configurações > Sobre.

## T8. Entrar (KBC-010)

**Objetivo:** entrar com a própria conta Google em um clique. **Sucesso:** do botão ao app sem digitar nada.

- Tela própria, centralizada, antes de qualquer outra (login obrigatório, inclusive no Mac do dono): "Nova Alexandria" (título; nome do produto desde o KBC-016), uma linha de descrição, o botão do Google "Fazer login com o Google" (Google Identity Services) e a nota "Suas conversas e configurações ficam no servidor da Nova Alexandria."
- Abaixo do botão do Google, separado por "ou": **Entrar com código** (botão secundário) e o link **Pedir acesso sem conta Google** (T10, KBC-014).
- Sem convite (Google): "Seu acesso ainda não foi liberado." com **Solicitar acesso** (primário) e "Sair" (volta ao botão, sem o login automático do Google). Solicitar abre, no mesmo cartão, o e-mail do Google (só leitura), o campo **Celular (opcional)** e "Enviar solicitação"; depois: "Solicitação enviada. Você recebe um e-mail quando um master aprovar." Se já houver uma solicitação: "Sua solicitação está em análise." ou "Sua solicitação foi recusada. Você pode pedir de novo a partir de dd/mm às hh:mm." (KBC-014 BR-7).
- Qualquer resposta 401 depois disso (sessão revogada ou vencida) recarrega a página e volta a esta tela; nada da pessoa anterior fica na memória (BR-6).

| Estado | Mostra |
|---|---|
| Carregando | "Carregando…" |
| Sem client id | "O login não está configurado: defina GOOGLE_CLIENT_ID no .env e reinicie a API." |
| Script do Google indisponível | "Não consegui carregar o botão do Google…" + "Tentar de novo" |
| Entrando | "Entrando…" |
| Falha na verificação | a mensagem do erro (ex.: "Não consegui confirmar o login com o Google agora…") |
| Ticket vencido (mais de 15 min na tela) | "Esta tela ficou aberta tempo demais. Entre com o Google de novo para pedir acesso." |

## T9. Pessoas e permissões (KBC-010, só masters)

- Seção de ⚙ Configurações, aberta também pela lateral ("Pessoas e permissões", acima de ⚙). Some para quem não é master; a seção IA some para quem não tem "Configurações de IA próprias".
- **Convidar por e-mail** (rótulo acima do campo) + "Convidar"; dica: quem é convidado começa com "Buscar documentos" e nenhum acervo (BR-3).
- **E-mail de convite** (KBC-026): abaixo do campo e antes de "Convidar" (na ordem do Tab também), a caixa "Não enviar e-mail de convite" (desmarcada: o e-mail sai). Aviso depois de convidar: "Convite enviado para … ." · "Convite criado sem e-mail. … já pode entrar com o Google ou com um código por e-mail." · falha, como erro: "Convite criado, mas o e-mail não foi enviado. O acesso já vale; tente "Reenviar convite" mais tarde." · reconvite de um endereço que recebeu convite há pouco (revogado e convidado de novo dentro do limite): "Convite criado sem e-mail: … já recebeu um convite há pouco." Com a caixa marcada, a dica vira "Nenhum e-mail será enviado. …". Depois de reenviar, o foco volta ao botão.
  - Status na linha, no lugar de "Ainda não entrou": selo "Ativo" + "Último acesso …" depois do primeiro acesso; antes dele "Convite enviado em dd/mm/aaaa hh:mm", "⚠ Falha ao enviar o convite" (cor de perigo, ícone e texto) ou "Ainda não entrou" (nenhum e-mail de convite).
  - Na pessoa aberta que ainda não entrou, abaixo do editor, junto das ações da pessoa e logo acima do status (o resultado aparece ao lado do botão, MA-23): "Reenviar convite" (ou "Enviar convite" quando nenhum saiu), secundário, desabilitado durante o envio. Resultado no status da pessoa: "Convite reenviado para … ."; limitado: "Este convite foi enviado há pouco. Você pode reenviar a partir de dd/mm hh:mm."; falha: "Não consegui enviar o e-mail. O convite continua valendo; tente de novo mais tarde."
- **Solicitações pendentes** (KBC-014), acima da lista, só quando houver alguma: título com a contagem; por solicitação, nome, e-mail, celular (ou "sem celular"), origem ("Google" ou "Cadastro") e data. Ações lado a lado (MA-04): **Aprovar** (primário) e **Recusar** (secundário).
  - Aprovar: a pessoa entra na lista com "Buscar documentos" e nenhum acervo, o editor dela abre e o status diz "Acesso aprovado. Escolha os acervos de … ." (BR-6).
  - Recusar pede confirmação na linha (MA-27): "Recusar a solicitação de …? A pessoa só poderá pedir de novo em 24 horas." · "Recusar" · "Cancelar"; o foco segue o botão (WCAG 2.4.3).
  - Erros na própria linha (MA-23), ex.: "Este e-mail já foi convidado.".
- A lateral mostra no botão "Pessoas e permissões" um selo com o número de solicitações pendentes (só masters; nome acessível "3 solicitações pendentes"); o selo some com zero.
- Lista: nome (ou e-mail), e-mail, selos "Master" e "Dono", acervos, último acesso ("Ainda não entrou") e, só para o dono, "Gasto de IA hoje: US$ …" (BR-6). Um convite recusado aparece logo abaixo do campo de e-mail. Abrir uma pessoa mostra:
  - **Acervos** e **Funcionalidades** (Buscar documentos, Pesquisa com IA, Montar/ampliar acervo, Configurações de IA próprias), caixas de seleção que salvam ao mudar ("Salvo."). Para um master aparecem marcadas e desabilitadas: "Masters veem todos os acervos e usam todas as funcionalidades."
  - "Tornar master" / "Remover master"; recusas em texto claro: "Deve restar ao menos um master.", "A conta do dono não pode ser rebaixada nem removida."
  - **IA da aplicação** (KBC-022), no editor da pessoa: "Qual IA atende esta pessoa" (seleção: Padrão (Plano da casa) · Plano da casa · Nenhuma), "Usar sempre a IA da aplicação, mesmo se ela tiver a própria", "Pesquisas por dia" (vazio = padrão), "Liberar modelo pago de reserva" + "Teto por mês (US$)". A linha da pessoa mostra "IA: Plano da casa (OpenRouter)" (com "(sempre)" quando marcado); a escolha da própria IA é dela e não aparece ao master (KBC-010 BR-6). "Histórico da IA" (recolhido) lista quem mudou, quando e para quê.
- **Assinatura do ChatGPT cedida** (KBC-027): a opção "ChatGPT do administrador" segue o mesmo padrão, com os termos da OpenAI ("Os termos da OpenAI não permitem usar a assinatura do ChatGPT para atender outras pessoas. …") e os títulos "Ceder a assinatura do ChatGPT a …"; a opção só aparece enquanto pode ser cedida (Codex ligado e com login); numa pessoa que já a tem, continua visível com "A assinatura do ChatGPT está desligada em IA da aplicação, sem login no servidor ou com o contêiner do Codex sem responder; a pessoa segue com a própria IA ou sem IA até lá."
- **Assinatura do Claude cedida** (KBC-024): só o dono vê a opção "Claude do administrador" em "Qual IA atende esta pessoa" e na barra em massa. Ao escolhê-la, uma confirmação na linha (MA-27; grupo com o título e os termos como descrição), com o foco em "Cancelar": título "Ceder a assinatura do Claude a esta pessoa?" (na barra: "… a 1 pessoa selecionada?", "… a N pessoas selecionadas?" ou "… a todas as N pessoas?"), os termos "Os termos da Anthropic não permitem usar a assinatura do Claude para atender outras pessoas. Ceder é decisão sua e pode levar a limites ou ao bloqueio da sua conta. Quem recebe passa a usar os limites da sua assinatura do Claude, com o próprio limite de pesquisas por dia." · "Ceder assim mesmo" · "Cancelar" (lado a lado também no celular). Escolher outra IA ou mudar outro campo fecha a confirmação sem ceder; depois de ceder, o foco volta à escolha. Com a assinatura escolhida e o Claude Code fora do ar, a ajuda diz: "A assinatura não está disponível agora no servidor; a pessoa segue com a própria IA ou sem IA até lá." Nunca aparece como IA padrão; na barra, "também para os próximos" fica desabilitado com "A assinatura não pode valer para os próximos convidados." O histórico diz "(termos confirmados)". Numa pessoa com a assinatura, só o dono muda a cota, "sempre" e a reserva paga; qualquer master pode revogar.
- **Convite pré-configurado** (KBC-028): abaixo do e-mail, "Perfil" (seleção: os perfis de convite, com "(padrão)" no padrão, e "Nenhum") e o botão secundário "Configurar agora", que abre o editor de preset já preenchido pelo perfil escolhido; mudar o editor não altera o perfil. O editor de preset tem, em grupos: **Papel** (caixa "Master"), **Acervos** (caixas), **Funcionalidades** (caixas), **IA da aplicação** (Padrão · Plano da casa · Nenhuma; para o dono, no convite, também as assinaturas que podem ser cedidas agora, com a mesma confirmação dos termos da cessão (título "Ceder a assinatura do … a quem você está convidando?"; enquanto ela está aberta, "Convidar" espera com "Confirme ou cancele a cessão da assinatura em “IA da aplicação” para convidar."), depois dela "Termos da assinatura do … confirmados para este convite. Para desfazer, escolha outra IA." numa região viva, e, para cada assinatura que não aparece, o motivo ("A assinatura do ChatGPT não aparece agora: …"), KBC-031; perfis nunca guardam assinaturas; "Usar sempre"; pesquisas por dia; reserva paga + teto por mês) e **Preferências iniciais** (acervo padrão, entre os marcados; visão inicial; perfil de pesquisa; tema). Erros nos campos (MA-23). Depois de convidar, o aviso diz o perfil usado ("Convite enviado para …. Perfil: Aluno."; "Perfil: configuração própria." quando o preset foi ajustado).
- **Perfis de convite** (KBC-028): seção recolhível em Pessoas e permissões (botão "Perfis de convite (n)" com aria-expanded): a lista (nome, "Padrão" no padrão), "Novo perfil", e por perfil "Editar", "Tornar padrão" e "Apagar" (confirmação na linha). O mesmo editor de preset, com o nome do perfil acima.
- **Aplicar perfil** (KBC-028): no editor da pessoa, "Aplicar perfil" + seleção + confirmação na linha ("Aplicar o perfil Aluno a …? Papel, acervos, funcionalidades e IA mudam; as preferências que a pessoa já salvou continuam."). As preferências do perfil só valem para quem ainda não salvou as próprias.
- **Seleção em lote**: caixa por pessoa e "Selecionar todos"; com seleção, uma barra "N selecionadas · IA da aplicação: [escolha] · Aplicar" e, para todos, "Aplicar a todos os usuários" com "também para os próximos convidados".
- "Revogar acesso" pede confirmação ("Revogar o acesso de … ? A pessoa sai na hora." · "Revogar" · "Cancelar"); a conta do dono não tem essa ação.
- A lateral mostra a pessoa (foto ou inicial, nome, e-mail) e "Sair". A visão "Pesquisa com IA" e os acervos não liberados não aparecem; um convidado sem acervo vê "Nenhum acervo foi liberado para você ainda; peça a um master."

## T10. Pedir acesso e entrar com código (KBC-014)

**Objetivo:** quem não tem convite pede acesso; quem foi aprovado entra sem senha. **Sucesso:** pedir acesso em um formulário e um código; entrar em dois passos (identificador, código).

Mesma tela e cartão de T8 (centralizado, uma coluna, MA-17). "← Voltar" no topo do cartão leva ao botão do Google.

**Pedir acesso sem conta Google**
1. Campos com rótulo acima (MA-16): **E-mail**, **Nome**, **Sobrenome** (lado a lado só a partir de 480 px), **Celular** com a dica "Com DDD. Ex.: (81) 99999-0000. Sem código de país, usamos +55." antes do campo (MA-20). Teclados: `email`, `tel` (MA-12). "Enviar código" (primário).
2. Resposta sempre igual (KBC-014 BR-3): "Se o e-mail puder ser usado, enviamos um código de 6 dígitos para …". Campo **Código** (`inputmode="numeric"`, `autocomplete="one-time-code"`, 6 dígitos) e "Confirmar"; "Reenviar código" e "Trocar e-mail" como links.
3. Sucesso: "Solicitação enviada. Um master vai analisar; você recebe um e-mail quando for aprovado."

**Entrar com código**
1. Quando o SMS está ligado: "Receber o código por" com rádios **E-mail** / **SMS** (MA-19); sem SMS, só o campo **Seu e-mail** (BR-9; com SMS, **Seu e-mail** ou **Seu celular**). "Enviar código".
2. "Se houver um acesso para …, enviamos um código." Campo **Código** e "Entrar"; "Reenviar código" e "Trocar".
3. Entrou: o app abre como no Google.

| Estado | Mostra |
|---|---|
| Enviando / Confirmando | botão desabilitado e "Enviando…" / "Confirmando…" na linha de status |
| Campo com erro | ao lado do campo, com ícone e texto (MA-23): "Digite um e-mail válido, como nome@exemplo.com.", "Digite o celular com DDD.", "Digite seu nome.", "O código tem 6 dígitos." |
| Código errado ou vencido | "Esse código não confere ou já venceu. Confira os 6 dígitos ou peça um novo." (MA-25) |
| Muitos pedidos | "Muitos pedidos em pouco tempo. Espere um minuto e tente de novo." |
| Servidor fora | a mensagem de servidor indisponível + o que foi digitado continua (MA-26) |

Acessibilidade: o foco vai para o campo do código quando ele aparece; status em `role="status"`, erros com `aria-invalid` e `aria-describedby`; alvos ≥ 44 px.

## T11. Política de privacidade (KBC-016, pública)

- Rota `/privacidade`, aberta com ou sem sessão (a tela de consentimento do Google aponta para ela). Link discreto "Privacidade" abaixo da nota da tela de entrada.
- Coluna de leitura (até 42rem, serifa de leitura, três tamanhos de texto): "Nova Alexandria" (marca discreta, link para o início), h1 "Política de privacidade", introdução e as seções h2 "Quais dados guardamos", "Para que usamos", "Quem participa", "Por quanto tempo", "Seus direitos"; "Última atualização" e o link "Voltar à Nova Alexandria".
- "O responsável pelos dados é o administrador da Nova Alexandria, que aprova os acessos." Contato para pedidos sobre os dados: o e-mail do dono (`KB_CHAT_OWNER_EMAIL`, por `GET /api/v1/auth/config`) como link `mailto:`; sem ele (ou com erro), "fale com o administrador que aprovou o seu acesso"; enquanto carrega, só "…".
- Título da aba: "Privacidade — Nova Alexandria"; nas outras telas, "Nova Alexandria".

## T12. IA da aplicação (KBC-022, só masters)

**Objetivo:** dar IA a quem não tem, sem custo, controlando quem usa o quê. **Sucesso:** conectar a conta da casa em um clique e ver cada pesquisa da casa com custo e cota.

- Seção de ⚙ Configurações ("IA da aplicação"), entre "IA" e "Preferências"; some para quem não é master.
- **Conta OpenRouter da aplicação** (cartão de status): "Conectada ••••abcd · por e-mail em dd/mm" ou "Não conectada". Ações: **Conectar OpenRouter** (primário; vai ao OpenRouter e volta), "Colar uma chave" (abre o campo só de escrita + "Salvar chave"), "Testar conexão" e "Desconectar" (confirmação na linha). Linha "Pedidos gratuitos hoje: 12 de 1000" (ou 50, com a dica: "Com US$ 10 em créditos comprados uma vez, o limite sobe para 1000 por dia.").
- **Modelos gratuitos**: "Escolher automaticamente (recomendado)" ligado por padrão, com a lista atual (nome, id, contexto) e "Atualizada às hh:mm". Desligado, caixas de seleção na ordem da lista. "Usar openrouter/free como última opção" (ligado). Nota: "Só modelos gratuitos com ferramentas; se um estiver ocupado, o próximo responde."
- **Modelo pago de reserva** (desligado por padrão): campo de id com sugestões e a nota "Só entra para quem você liberar, até o teto mensal da pessoa."
- **Para quem**: "IA padrão para quem não tem atribuição" (rádio: Plano da casa · Nenhuma) e "Pesquisas por dia (padrão)" com a ajuda: "Rápido conta 1, Profundo 2, Exaustivo 5."
- **Assinatura do ChatGPT (Codex)** (KBC-027): caixa "Ligar a assinatura do ChatGPT (Codex)" (desligada por padrão; desabilitada quando o servidor não tem o Codex configurado) e uma linha de estado que começa por **Ligada** ou **Desligada**: "… · Logado no servidor." · "… · O Codex não está logado no servidor: o dono entra por SSH com `codex login --device-auth` (runbook, passo 9c)." · "… · O contêiner do Codex não respondeu…" · "… · O Codex não está configurado neste servidor…". Ajuda: "Ligada, você usa o ChatGPT em ⚙ Sua IA e pode cedê-lo em Pessoas e permissões. O Codex roda num contêiner separado, sem acesso aos segredos nem ao estado do servidor: ele lê o acervo só pelas ferramentas da pesquisa, e a pergunta vai à OpenAI."
- **Chave de gerenciamento (opcional)**: só escrita; "Com ela, cada pessoa com reserva paga ganha uma chave com limite mensal no próprio OpenRouter."
- Volta do OpenRouter: a seção abre sozinha com "Conta conectada." ou "Não consegui conectar. Tente de novo." (status anunciado).

| Estado | Mostra |
|---|---|
| Carregando | "Carregando…" |
| Lista gratuita indisponível | "Não consegui atualizar a lista agora; usando a última." ou, sem nenhuma, "Sem lista de modelos gratuitos; tente de novo." + "Tentar de novo" |
| Erro ao salvar | "Não consegui salvar. Tente de novo." |

## T13. Tutorial "Como usar" (KBC-032, público)

- Rota `/tutorial`, aberta com ou sem sessão; título da aba "Como usar — Nova Alexandria". Links: "Como usar" ao lado de "Privacidade" na tela de entrada; ícone "?" com "Como usar" no topo do app (no celular, só o ícone; nome acessível "Como usar a Nova Alexandria (abre em nova aba)", abre em nova aba para não perder a conversa); "Como usar a Nova Alexandria" no pé da política.
- Coluna de leitura de até 48rem, com os tamanhos de tipo da política (h1; h2 em `--text-lg`; texto e h3 em `--text-md`; legendas em `--text-sm`): marca discreta, h1 "Como usar a Nova Alexandria", introdução, sumário "Nesta página" (cartão; duas colunas a partir de 720 px) e as seções h2 com âncoras estáveis: `o-que-e`, `entrar`, `busca`, `pesquisa-com-ia`, `historico`, `sua-ia`, `preferencias`, `administradores` (rótulo "Só para administradores", texto em destaque, sem forma de botão), `perguntas-frequentes`. Abrir `/tutorial#<âncora>` rola até a seção e leva o foco ao título.
- Cada seção: texto curto, passos numerados (círculos com o número) e figuras: captura real do app com destaques por letra (contorno laranja e letra A, B, C… num quadrado escuro no canto) que a legenda explica; as letras não se confundem com os passos numerados do texto (círculos); legenda + "Ver a imagem ampliada" (nova aba). Capturas altas (celular, lateral) ficam com até 20rem, centralizadas. Tabela dos três tipos de pesquisa (rola na horizontal no celular). "Voltar ao sumário" ao fim das seções; no pé, "Voltar à Nova Alexandria" e "Privacidade".
- Imagens: WebP com hash no nome, `width`/`height` declarados, só a primeira do computador e a primeira do celular sem carregamento preguiçoso; total < 3 MB.

## T14. Mídia: lista do acervo e envio (KBC-034, KBC-035)

**Objetivo:** achar e abrir um áudio do acervo; para quem envia, mandar um áudio e acompanhar até ficar pronto. **Sucesso:** abrir um áudio em 1 clique a partir da lista; enviar um áudio em até 4 passos (escolher arquivo, conferir título, escolher autoria, enviar), sem voltar para corrigir.

### Onde fica
- Item **Mídia** na lateral, logo abaixo de **Acervo ▾** (UP-05: mesma posição em todas as telas), com a contagem de mídias prontas do acervo. Rotas: `/midia` (lista do acervo selecionado) e `/midia/{id}` (player, T15). Trocar de acervo na lateral troca a lista.
- No celular, **Mídia** fica no menu ☰, e a lista ocupa a tela cheia com "← Voltar" (UP-04).

### Lista (SL-14, SL-17, DS-07)
- Cabeçalho: "Mídia — Hermetismo", a contagem ("42 áudios · 31 h") e, para quem tem `media-upload`, o botão primário **Enviar áudio** (SL-18). Com mais de 10 itens, um campo **Filtrar por título** (rótulo visível, SL-04) filtra na hora.
- Cada linha: título (até 2 linhas, depois reticências com o título inteiro no `title` e no nome acessível), selo de autoria (o mesmo do T2), duração (`1:02:15`, algarismos tabulares), data do envio e o **status em texto** (UP-20): "Na fila", "Convertendo… 40%", "Transcrevendo…", "Pronta", "Falhou: <motivo>". Uma mídia com baixa confiança leva o selo "Baixa confiança" (KBC-038). Uma mídia com posição salva mostra a barra fina de progresso e "Continuar de 23:10" (KBC-041).
- Ordem: mais recentes primeiro. A linha inteira é o alvo de clique (≥ 48 px de altura, MA-01), mas só abre o player quando a mídia está pronta. Nas outras, o clique não faz nada e o status explica por quê.
- Enquanto há itens em "Na fila", "Convertendo" ou "Transcrevendo", a lista se atualiza a cada 5 s (como no T5), sem pular a rolagem nem roubar o foco. A mudança para "Pronta" é anunciada uma vez numa região `aria-live="polite"` ("Palestra de 1998 está pronta.").

### Envio (MA-15 a MA-20, MA-23 a MA-26)
1. **Enviar áudio** abre um painel lateral (diálogo no celular, tela cheia) com saída "Cancelar" (UP-04). No desktop, a área aceita arrastar e soltar; o botão "Escolher arquivo" é sempre a alternativa (UP-09).
2. A regra aparece **antes** da escolha (MA-20): "mp3, m4a, wav, flac, ogg ou opus, até 500 MB". O arquivo errado é recusado na hora, ao lado do campo, com a correção (MA-25): "Este arquivo não é um áudio aceito. Envie mp3, m4a, wav, flac, ogg ou opus." / "Este arquivo tem 612 MB. O limite é 500 MB."
3. Campos, em uma coluna e com rótulo acima (MA-16, MA-17): **Título** (preenchido com o nome do arquivo sem extensão, editável), **Acervo** (o selecionado, trocável) e **Autoria**, com dois rádios sem pré-seleção (MA-19, SL-28): "Mestre Laércio" / "Outros autores". A autoria é obrigatória, porque uma escolha errada mistura as obras (ADR 0015).
4. **Enviar** mostra o progresso real ("Enviando… 128 de 312 MB · 41%") com **Cancelar envio**. Sair da página durante o envio pede confirmação do navegador. Ao terminar, o painel fecha, a mídia aparece no topo da lista em "Na fila" e o foco vai para ela (UP-01).
5. Se a conexão falhar, aparece "O envio parou: verifique a conexão e tente de novo." com **Tentar de novo**, mantendo os campos (MA-26). No KBC-035, o envio passa a continuar de onde parou.

### Falhas e remoção (só masters)
- "Falhou: o arquivo não é um áudio válido" não oferece nova tentativa. Uma falha temporária ("Falhou: a conversão parou 3 vezes") oferece **Tentar de novo** na própria linha (UP-13).
- **Remover** fica no menu "⋯" da linha. Como apaga o áudio convertido e a transcrição sem volta, pede confirmação em diálogo (UP-07), que nomeia o item: "Remover 'Palestra de 1998'? O áudio e a transcrição serão apagados e não podem ser recuperados." Os botões são "Remover" (perigo) e "Cancelar".

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Carregando | Esqueleto de 5 linhas com a altura real | — |
| Vazio, quem envia | "Ainda não há áudios neste acervo." + **Enviar áudio** | Enviar |
| Vazio, quem não envia | "Ainda não há áudios neste acervo." | — |
| Filtro sem resultado | "Nenhum áudio com 'xyz' no título." + **Limpar filtro** (SL-14) | Limpar |
| Erro ao carregar | "Não consegui carregar a mídia deste acervo." + **Tentar de novo** | Tentar |
| Sem acesso ao acervo / `KB_CHAT_MEDIA=off` | O item **Mídia** não aparece; a rota direta mostra a tela de não encontrado | — |
| Conteúdo extremo | 500 itens: a lista é virtualizada; títulos de 200 caracteres quebram em 2 linhas | — |

## T15. Player (KBC-034, KBC-041, KBC-038, KBC-039)

**Objetivo:** ouvir uma palestra longa, lendo junto quando quiser, e voltar a um trecho sem procurar o minuto. **Contexto:** sentado, estudando no computador (fones, às vezes com anotações); no celular, ouvindo com a tela bloqueada ou trocando de app. **Sucesso:** voltar 15 s, mudar a velocidade e pular para uma frase sem errar o controle; retomar no dia seguinte, em outro aparelho, do ponto onde parou; nenhum controle depende só do mouse ou de gesto.

Referência de convenções (UP-05): os controles de áudio longo dos apps de podcast e de vídeo mais usados: voltar 15 s e avançar 30 s, velocidade num menu, barra com tempo decorrido e restante e atalhos de teclado no padrão do YouTube.

### Layout
```
Desktop (≥ 1024 px)                                           Celular (< 1024 px)
┌──────────┬───────────────────────────────────┬──────────┐    ┌──────────────────────┐
│ Lateral  │ ← Mídia   Palestra de 1998        │Transcrição│   │ ← Mídia              │
│          │ ✦ Mestre Laércio · 1:02:15         │ (KBC-038) │   │ Palestra de 1998     │
│          │ ┌───────────────────────────────┐ │ trecho    │   │ ✦ Mestre Laércio     │
│          │ │ [legenda, quando ligada]      │ │ ativo     │   │ ━━━━━━●──────────    │
│          │ │ ━━━━━━━━━━●──────────────────  │ │ destacado │   │ 23:10      -39:05    │
│          │ │ 23:10                  -39:05 │ │ ...       │   │  ⟲15   ▶   30⟳       │
│          │ │ ⟲15  ▶  30⟳   1,5×  CC  🔊 ⋯   │ │           │   │ 1,5×   CC   ⋯        │
│          │ └───────────────────────────────┘ │           │   │ [legenda]            │
│          │ Copiar link deste minuto          │           │   │ Transcrição (abaixo) │
└──────────┴───────────────────────────────────┴──────────┘    └──────────────────────┘
```
- O player é um componente próprio sobre um único `<audio>` sem o atributo `controls`: os controles nativos variam entre navegadores e não seguem os temas (DS-12).
- **Mini-player persistente (KBC-041):** ao sair de `/midia/{id}` com o áudio tocando, ele continua. Uma barra de 64 px aparece no pé da área principal (no celular, acima da caixa de pergunta) com o título (link de volta ao player), ⟲15, ▶/❚❚, a barra de progresso fina e ✕ ("Fechar o player", que pausa e salva a posição). Assim dá para ouvir enquanto busca.

### Controles (UP-13, MA-06, SL-20)
| Controle | Comportamento | Nome acessível |
|---|---|---|
| ▶ / ❚❚ (o maior, 56 px) | Tocar/pausar. Durante o carregamento, depois de 300 ms sem som (UP-14), vira um indicador de carregamento que continua clicável para pausar | "Tocar" / "Pausar" (muda com o estado) |
| ⟲15 / 30⟳ | Volta 15 s / avança 30 s, sem passar de 0 ou do fim | "Voltar 15 segundos" / "Avançar 30 segundos" |
| Barra de progresso | `role="slider"`. Clique ou arraste para pular; mostra o trecho já carregado em tom mais fraco; no desktop, passar o mouse mostra o tempo do ponto numa etiqueta (só um complemento, UP-09). Teclado: ←/→ 5 s, PageUp/PageDown 60 s, Home/End início/fim | "Posição", `aria-valuetext` "23 minutos e 10 segundos de 1 hora, 2 minutos e 15 segundos" |
| Tempos | À esquerda o decorrido; à direita o restante (`-39:05`); tocar no restante alterna para a duração total, e a escolha é lembrada | — |
| Velocidade | Botão com o valor ("1,5×") que abre um menu com 0,75× · 1× · 1,25× · 1,5× · 1,75× · 2×, o atual marcado com ✓ e em texto. Vale para todas as mídias e é guardada na conta (BR do KBC-041) | "Velocidade: 1,5 vezes" |
| CC (KBC-038) | Liga/desliga a legenda, `aria-pressed`; a escolha é lembrada | "Legendas" |
| Volume (só com ponteiro fino) | Botão de mudo + controle deslizante horizontal; escondido em telas de toque, onde o volume é o do aparelho (iOS ignora o volume da página) | "Silenciar" / "Volume, 80%" |
| ⋯ | "Copiar link deste minuto" (KBC-038) e "Atalhos de teclado" | "Mais opções" |

Os tempos usam `m:ss` abaixo de 1 h e `h:mm:ss` a partir de 1 h, em algarismos tabulares, para não tremer ao contar.

### Atalhos de teclado (UP-09: todos também têm botão)
Ativos quando o foco está no player, na transcrição ou em lugar nenhum, e **nunca** com o foco num campo de texto: Espaço ou K tocar/pausar · J voltar 15 s · L avançar 30 s · ←/→ 5 s · Shift+, e Shift+. diminuir/aumentar a velocidade · M silenciar · C legendas · 0–9 ir para 0%–90% · ? lista dos atalhos (diálogo com "Fechar" e Esc). A barra de progresso, quando focada, usa as próprias setas e não dispara o atalho duas vezes.

### Sistema operacional (Media Session API)
Título, autoria ("Mestre Laércio — Nova Alexandria") e o ícone do app na tela de bloqueio e na central de controle; tocar, pausar, voltar 15 s, avançar 30 s e arrastar a posição funcionam por lá e pelos botões de fone. A posição e a velocidade são informadas ao sistema (`setPositionState`), para a barra da tela de bloqueio ficar certa.

### Retomar (KBC-041)
- A posição é salva na conta a cada 10 s tocando, ao pausar, ao trocar de mídia e ao fechar a página (envio que sobrevive ao fechamento). Abrir a mídia de novo mostra "Continuar de 23:10" (botão primário) e "Começar do início". Nunca toca sozinho ao abrir (sem autoplay).
- Ao chegar a 95% ou ao fim, a posição é zerada e a mídia conta como ouvida. O fim mostra **Ouvir de novo**.
- Um link com `?t=` (KBC-038) ou um resultado da busca (KBC-039) vence a posição salva, porque a pessoa pediu aquele minuto.

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Carregando a mídia | Título e autoria (já conhecidos) + controles desativados com explicação no nome acessível | — |
| Pronto, nunca ouvida | Controles ativos, posição 0:00 | Tocar |
| Com posição salva | "Continuar de 23:10" / "Começar do início" | Escolher |
| Tocando / pausado | ❚❚ / ▶; o título da aba ganha "▶ " enquanto toca | — |
| Esperando dados | Indicador no botão principal após 300 ms; o tempo não anda | Pausar |
| Erro de rede ou do arquivo | "Não consegui carregar o áudio. Verifique a conexão." + **Tentar de novo**, que retoma do mesmo segundo (MA-26) | Tentar |
| Sessão expirada | Pausa e mostra "Sua sessão expirou. Entre de novo para continuar ouvindo." com **Entrar**; a posição já está salva | Entrar |
| Mídia removida / sem acesso | Tela de não encontrado ("Esta mídia não está mais no acervo ou você não tem acesso a ela.") | Voltar à Mídia |
| Ainda não pronta | O status da lista (T14) no lugar do player | — |
| Terminou | **Ouvir de novo** | Ouvir |
| Conteúdo extremo | 4 h de áudio: a barra continua precisa (1 px ≈ 9 s numa barra de 1.600 px; o teclado dá precisão de 5 s); título de 200 caracteres quebra em 2 linhas | — |

### Transcrição ao lado (KBC-038)
- Coluna de leitura (Source Serif 4, 65–75 caracteres) ao lado do player no desktop; no celular, abaixo dele, com o player fixo no topo ao rolar. Cada segmento é um botão com o tempo à esquerda ("12:34", algarismos tabulares) e o texto.
- O segmento ativo tem fundo de destaque **e** uma barra lateral (UP-20). Ele fica visível sozinho, sem rolagem brusca (respeita `prefers-reduced-motion`: sem animação). A rolagem manual pausa o acompanhamento por 5 s, e aparece **Voltar ao trecho atual** enquanto ele estiver fora da vista.
- Baixa confiança: "Transcrição automática de baixa confiança: pode haver trechos errados." acima do texto, em tom de aviso (não vermelho, UP-19), sempre visível.
- Legenda sobre a área do player (fundo escuro translúcido, texto claro, contraste ≥ 4,5:1 em todos os temas), no máximo 2 linhas.

### Acessibilidade e toque (MA-01 a MA-07, MA-29, WCAG 2.2 AA)
- Alvos ≥ 44 × 44 px (≥ 48 px no celular); o botão principal tem 56 px e fica no centro, ao alcance do polegar (MA-06, MA-07).
- Foco visível com contraste ≥ 3:1 em todos os controles e segmentos; a ordem de Tab segue a ordem visual (player, depois transcrição).
- Nenhum anúncio a cada segundo: a região `aria-live` só fala em erros, em "pronta" e quando a pessoa pede. O slider fala o tempo em palavras.
- Nenhum controle só por gesto ou por passar o mouse (UP-09, SL-22); arrastar a barra tem a alternativa do teclado e dos botões ±.
- O estado é sempre também texto ou forma, nunca só cor (UP-20); as cores vêm dos tokens dos três temas.

### Fora do escopo e perguntas em aberto
- **Fora:** baixar o áudio; listas de reprodução e fila de próximos; faixas e capítulos (fase B); compilados (fase C); vídeo (KBC-035 usa o mesmo player com a área de vídeo); editar a transcrição.
- **Precisa de teste com usuários** (UP-25): os rótulos ⟲15/30⟳ e o "Continuar de" são entendidos? O mini-player atrapalha a leitura dos resultados no celular? Entra no teste da fase 2 com 1 a 2 colegas (`docs/product/context.md`, ## Research).

## Temas e tokens (DS-12, UP-17 a UP-19)

Tokens DTCG em `apps/web/src/styles/tokens.json` (cores; `scripts/tokens.mjs` gera o CSS) com três conjuntos: `light`, `dark` e `esoteric`. No máximo 3 tamanhos de tipo por tela. O vermelho fica reservado para erros.

| Token | Claro | Escuro | Esotérico |
|---|---|---|---|
| `color.bg` | creme quente `#F7F5F0` | `#1F1E1C` | noite índigo `#14121F` |
| `color.surface` | `#FFFFFF` | `#2A2926` | `#1E1B2E` |
| `color.text` | `#1F1E1C` | `#EDEAE3` | `#E9E2CF` |
| `color.accent` | terracota `#A64D29` | `#E0835D` | dourado `#C9A54A` |
| `font.reading` | serifada (Source Serif 4) | idem | Cormorant Garamond (títulos) + Source Serif 4 (corpo) |
| `font.ui` | sans (Inter) | idem | idem |

Todo par texto/fundo e acento/fundo deve passar 4,5:1 (AA). A verificação entra nos testes. O tema esotérico usa ornamento só em títulos e divisores (um glifo ☿ discreto), nunca no texto corrido (DS-16: legibilidade acima da estética).

## Acessibilidade (WCAG 2.2 AA, MA-29)

- Navegação completa por teclado: Tab pelos chips e cartões; Esc fecha popover e painel; `/` foca a caixa de pergunta.
- Região `aria-live="polite"` anuncia "23 resultados" e "Resposta da IA pronta".
- Foco visível com contraste ≥ 3:1. Alvos ≥ 44×44 px no celular (MA-01, SL-19).
- Estado de chips e filtros em texto, não só em cor (UP-20). Respeitar `prefers-reduced-motion`.

## Fora do escopo e perguntas em aberto

- **Fora:** autocomplete, histórico persistente, login, upload, edição, filas de revisão, conversa de IA multi-turno (cada "Responder com IA" é independente na R1).
- **Precisam de teste com usuários** (`docs/research/2026-10-23-search-habit.md`): os nomes "Ligação com o tema" e "Profundidade" são entendidos? O seletor "Como buscar" é descoberto? (UP-25: o piloto com o dono acontece antes do teste com colegas.)
- **Achado de dados:** quase todo o acervo tem profundidade 1 (3.987 de 4.235). O chip Profundidade discrimina pouco hoje. Ele fica na R1, mas vai **depois** dos outros, e a medição dirá se merece ficar (DS-22).
