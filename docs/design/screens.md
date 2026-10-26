# Telas e fluxos — Nova Alexandria (esqueleto + release 1)

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
3. Perguntar já pesquisa com IA. Na caixa de pergunta, um seletor segmentado **"Rápido | Profundo | Exaustivo"** (três rádios, MA-19) escolhe o perfil, com uma linha de ajuda ("Responde em segundos, com uma pesquisa curta e uma resposta direta." / "Pesquisa mais e usa o modelo mais forte; pode levar um minuto." / "Varre o acervo inteiro, página por página, e lista tudo o que achar; pode levar vários minutos."). O Exaustivo (KBC-017, ADR 0013) termina a resposta com uma linha "Cobertura: …" e pode dividir o trabalho entre sub-pesquisadores (KBC-018, ADR 0014): na lista de passos, cada um aparece como "Pesquisador N: …", recuado, e o resumo diz "· N pesquisadores"; o custo aparece como nos outros perfis ("Incluído na sua assinatura" ou "Custo: …"). O padrão vem de Configurações; o navegador lembra a última escolha (KBC-011). No celular, a ajuda fica só para leitores de tela.
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

---

### Rodapé da resposta e recusas (KBC-022)
- Rodapé: "Respondido por <modelo que respondeu> · Gratuito · Pesquisas restantes hoje: N" (plano da casa) ou "· Custo: US$ …".
- Cota esgotada: "Suas pesquisas com IA de hoje acabaram (N por dia). Volte amanhã ou conecte a sua própria IA." + botão "Conectar a minha IA" (⚙ > IA).
- Capacidade gratuita esgotada: "A IA gratuita da aplicação está sem capacidade agora. Tente mais tarde ou conecte a sua própria IA." + o mesmo botão.

## T5. Lateral: conversa, histórico, acervo e tema

- **+ Nova conversa** e o **histórico completo**, guardado pela API local neste computador e rotulado "salvo no servidor": todas as conversas das duas visões, sem limite (KBC-005 BR-1, emenda 2026-10-24). Restaurar uma conversa com IA mostra as respostas salvas sem chamar a IA.
- Uma conversa que ainda não chegou à API fica guardada no navegador e é reenviada sozinha; enquanto isso, a lateral avisa "Ainda não consegui salvar uma conversa no histórico…".
- **Acervo ▾**: lista de `kb topic list` com a contagem de documentos. Trocar de acervo inicia uma conversa nova (aviso inline, sem modal).
- **Tema**: "Automático (claro/escuro)" · "Claro" · "Escuro" · "Esotérico", lembrado no navegador.
- **Gasto com IA hoje: US$ 0,03 de US$ 1,00** (UP-02).

## T6. Configurações (KBC-007)

**Objetivo:** trocar quem responde (assinatura ou chave própria) e as preferências sem editar arquivos. **Sucesso:** trocar de provedor e ver a próxima resposta usar o novo, sem reiniciar.

- Aberta pelo **⚙ Configurações**, fixo no pé da lateral (desktop) e do menu (celular). Abre como diálogo modal sobre a conversa, que continua igual ao fechar (FR-6). No celular, ocupa a tela inteira.
- Seções à esquerda (no celular, abas no topo): **IA · Preferências · Sobre**. O foco começa no título; Esc e × fecham.
- **IA:** cartões de rádio, nesta ordem: Assinatura do Claude, Anthropic API, OpenRouter, Assinatura do ChatGPT, OpenAI API, Nenhum. Cada cartão mostra o custo em texto ("Incluído na sua assinatura" ou "Cobra por uso · chave própria"). Uma assinatura sem a ferramenta instalada aparece desabilitada, com "Não instalado." e o passo a passo de instalação e login (BR-3).
  - Provedor por uso: o campo da chave é só de escrita. Uma chave salva aparece como "Chave salva ••••abcd" com "Remover" (BR-1). Uma chave do servidor (variável de ambiente) é avisada.
  - **Modelo rápido** e **Modelo profundo** (KBC-011): um para cada perfil da pesquisa. Nas assinaturas, uma lista fechada ("Padrão: sonnet", `opus`, `haiku`…); nos provedores por uso, texto livre com sugestões. Vazio usa o padrão, mostrado na primeira opção ou no placeholder. Cada provedor guarda os seus.
  - Limite de gasto por dia (US$), só para os provedores por uso.
  - "Testar conexão" responde em até 20 s, numa linha de status (NFR-1, AC-5).
  - "Salvar" grava provedor, chave, modelo e limite juntos.
- **Preferências:** tela inicial (Pesquisa com IA ou Buscar documentos), pesquisa com IA por padrão (Rápido, Profundo ou Exaustivo), **Aprofundar automaticamente** (caixa de seleção, ligada por padrão, com uma linha de ajuda), acervo padrão, modo de busca e tema. Salvam ao mudar ("Salvo automaticamente.").
- **Sua IA** (KBC-023): a seção IA vira um guia. No topo, o cartão "Quem atende você agora" (IA ativa, quem paga, "Último teste: funcionando (dd/mm hh:mm)" ou o erro, e o uso de hoje: pesquisas restantes, "Gratuito" ou "Gasto hoje: US$ x de US$ y"). Depois, um cartão por opção, nesta ordem: **IA da aplicação** (voltar a ela), **OpenRouter** ("Conectar OpenRouter" em um clique ou colar a chave; "Só modelos gratuitos (recomendado)" ou "Modelo à escolha"; reserva paga opcional dentro do limite diário), **Gemini (gratuito)** (passos no Google AI Studio, colar a chave, plano Gratuito/Pago, aviso de privacidade), **Claude (API da Anthropic)**, **OpenAI (API)** e, só para o dono, as assinaturas. Cada cartão aberto mostra passos numerados, "Quanto custa", "Privacidade", "Limites" e links que abrem em nova aba ("(abre em nova aba)" no nome acessível). Claude e OpenAI avisam: "Assinaturas (Claude Pro/Max, ChatGPT Plus/Pro) não podem ser conectadas por outros apps; use uma chave de API."
- **Quem atende você** (KBC-022), no topo da seção IA: "IA da aplicação (cedida pelo administrador) · Plano da casa · Gratuito · Pesquisas restantes hoje: 3 de 5" ou "Sua IA · OpenRouter · você paga". O cartão "IA da aplicação" fica no topo da lista de provedores.
- **Sobre:** onde ficam os dados (~/.kb-chat, só o seu usuário lê); a assinatura nunca passa a senha à Nova Alexandria; "Rever o assistente de início".

| Estado | Mostra |
|---|---|
| Carregando | "Carregando…" e "Verificando o que está disponível…" |
| Servidor fora | "Não consegui carregar as configurações…" + "Tentar de novo" |
| Erro ao salvar | "Não consegui salvar. Tente de novo." (o rascunho continua na tela) |

## T7. Assistente de primeira abertura (KBC-007)

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
- **Chave de gerenciamento (opcional)**: só escrita; "Com ela, cada pessoa com reserva paga ganha uma chave com limite mensal no próprio OpenRouter."
- Volta do OpenRouter: a seção abre sozinha com "Conta conectada." ou "Não consegui conectar. Tente de novo." (status anunciado).

| Estado | Mostra |
|---|---|
| Carregando | "Carregando…" |
| Lista gratuita indisponível | "Não consegui atualizar a lista agora; usando a última." ou, sem nenhuma, "Sem lista de modelos gratuitos; tente de novo." + "Tentar de novo" |
| Erro ao salvar | "Não consegui salvar. Tente de novo." |

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
