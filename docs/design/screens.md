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
- **Selo de autoria** na primeira linha de cada cartão, antes do título: **"✦ Mestre Laércio"** em pílula cheia (acento; KBC-049: o nome do autor principal de cada acervo, "Mestre Laércio" no Hermetismo), **"Outros autores"** em pílula contornada, **"Síntese do acervo"** em contorno tracejado e **"Não classificado"** em contorno pontilhado e texto discreto. Leitores de tela ouvem "Autoria: …". Um documento sem autoria (dado antigo) não mostra selo.

### Na fala: trechos de áudio entre as referências (KBC-039; vídeo no KBC-075)
- **Buscar em** (primeira linha da mensagem, desenho igual ao de "Autoria", mas com caixas de seleção): **"Buscar em: Textos (12) · ♪ Áudios (3)"**. As contagens valem para cada tipo, qualquer que seja a escolha (como as facetas). Só aparece quando o acervo tem áudio transcrito que a pessoa pode ouvir (sem isso, um controle de uma opção só seria ruído, UP-15). A última caixa marcada fica desabilitada: nunca se busca em nada (BR-4, UP-06). A escolha refaz a mesma mensagem e é lembrada neste navegador para as próximas buscas. Padrão: tudo.
- **Trecho na fala**: cartão com o mesmo quadro do documento, misturado aos documentos pela relevância (só na primeira página): **"♪ Áudio · Na fala · 8:15"** (o leitor de tela ouve "aos 8 minutos e 15 segundos"), o título da gravação, a frase entre aspas com as palavras encontradas em `<mark>`, o selo do autor, "em <sub-acervo>" quando for o caso e o selo **"⚠ baixa confiança"** (contorno tracejado, tom de aviso, nunca vermelho, UP-19/UP-20) para transcrição automática de baixa confiança, que vem depois das de confiança normal (BR-3). O resumo da mensagem soma "· 2 trechos na fala".
- **Clique** → o painel de leitura (onde o texto abre; tela cheia no celular) mostra "♪ Áudio · Na fala · 8:15", o título (recebe o foco), o autor, o aviso de baixa confiança, o trecho encontrado em destaque, o player completo tocando de **2 s antes** do trecho e o link **"Abrir na página da mídia"** (`/midia/:id?t=`). O mini-player some enquanto o painel mostra o mesmo áudio e volta ao fechar (a reprodução continua). Com o painel de transcrição do KBC-038, o segmento do trecho fica marcado na transcrição.
- Filtros que a mídia não tem (tipo de texto, profundidade, ligação com o tema) escondem os trechos, assim como **Assuntos** para quem não tem `media-subjects`; "Autoria" e "Sub-acervo" valem para eles (BR-2). Sem a função "Ouvir mídia" ou sem acesso ao acervo, nenhum trecho aparece (BR-1).
- **Assuntos nas faixas (KBC-070, `media`, `media-tracks` e `media-subjects`):** com um assunto ativo, a mídia mostra as faixas ligadas a ele (só ligações aceitas). Sem texto, ou com o nome do assunto como pergunta, entram todas; com outro texto, a faixa precisa tê-lo na fala, no título ou no resumo. Cada faixa aparece uma vez: com a melhor passagem na fala ("♪ Áudio · Na fala · 8:15") ou inteira ("♪ Faixa · Assunto", título, resumo, abre no começo). Os assuntos aparecem como texto, porque o cartão inteiro é um botão. O filtro soma à parte: "Cabala (12 · 3 faixas)"; só faixas: "Preparo (3 faixas)". Assunto livre entra como opção do mesmo filtro.
- Estados do painel: carregando (bloco reservado do player), áudio ainda não pronto ("Este áudio ainda não está pronto para ouvir."), removido ou sem acesso ("Esta mídia não está mais disponível."), erro de rede (mensagem + "Tentar de novo").

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
4. **Veja também**: grupos "É exemplo de", "Aprofunda" e "Relacionados", cada um com até 5 links, que abrem no mesmo painel e mantêm um "← Voltar" (UP-04). Num conceito, para quem tem `media-subjects`, o grupo **Perguntas e respostas sobre este assunto** vem primeiro: até 5 faixas, mais recentes antes, com a gravação e a duração, e **Ver todas (N)**; cada uma abre o player no começo (KBC-070).
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
- **Editar acervo** (KBC-048; KBC-049 para o autor principal): diálogo com **Nome**, **Descrição** e, só num acervo de topo, **Autor principal**: um select com "Nenhum" e os autores do acervo, com a ajuda "Aparece com ✦ nos selos e filtros, e a IA nunca atribui a ele o que é de outros autores." Enquanto a lista carrega, o select fica desativado mostrando o principal atual ("Carregando os autores…"), nunca um "Nenhum" falso; se a lista falhar, "Não foi possível carregar os autores." com **Tentar de novo**; sem autores, "Este acervo ainda não tem autores: eles são cadastrados ao enviar um áudio." Um sub-acervo usa o principal do pai e não mostra o campo. Salvar grava tudo ou nada.
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
- Perfis de voz (KBC-071): "Quais dados" diz o que é o perfil e que só existe com consentimento; "Para que usamos", a finalidade única e a base legal; "Por quanto tempo", a revogação em até 1 minuto (com a exceção do computador suspenso), fora das cópias de segurança; "Seus direitos", revogar a qualquer momento.
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
- Cabeçalho: "Mídia — Hermetismo", a contagem ("42 áudios · 31 h") e, para quem tem `media-upload`, o botão primário **Enviar áudio** (SL-18). Com mais de 10 itens, um campo **Filtrar por título** (rótulo visível, SL-04) filtra na hora. Quando a lista tem duas ou mais autorias, o seletor **Autoria** (KBC-049, rótulo visível) oferece "Todos", "<autor principal>, principal" (texto, não ✦, porque a opção nativa lê o símbolo), os demais autores por nome e "Outros autores", cada um com a contagem; sem resultado, "Nenhum áudio desta autoria." com **Limpar filtro**.
- Cada linha: título (até 2 linhas, depois reticências com o título inteiro no `title` e no nome acessível), selo de autoria (o mesmo do T2; KBC-049: o nome do autor, "✦ Nome" em pílula cheia para o autor principal do acervo, "Outros autores" para mídia sem autor), duração (`1:02:15`, algarismos tabulares), data do envio e o **status em texto** (UP-20): "Na fila", "Convertendo… 40%", "Transcrevendo…", "Pronta", "Falhou: <motivo>". Uma mídia com baixa confiança leva o selo "Baixa confiança" (KBC-038). Uma mídia com posição salva mostra a barra fina de progresso e "Continuar de 23:10" (KBC-041).
- Ordem: mais recentes primeiro. A linha inteira é o alvo de clique (≥ 48 px de altura, MA-01), mas só abre o player quando a mídia está pronta. Nas outras, o clique não faz nada e o status explica por quê.
- Enquanto há itens em "Na fila", "Convertendo" ou "Transcrevendo", a lista se atualiza a cada 5 s (como no T5), sem pular a rolagem nem roubar o foco. A mudança para "Pronta" é anunciada uma vez numa região `aria-live="polite"` ("Palestra de 1998 está pronta.").

### Envio (MA-15 a MA-20, MA-23 a MA-26)
1. **Enviar áudio** abre um painel lateral (diálogo no celular, tela cheia) com saída "Cancelar" (UP-04). No desktop, a área aceita arrastar e soltar; o botão "Escolher arquivos" é sempre a alternativa (UP-09). Podem ser vários arquivos de uma vez (KBC-035); cada um vira uma linha com **Tirar**.
2. A regra aparece **antes** da escolha (MA-20): "mp3, m4a, wav, flac, ogg ou opus, até 4 GB cada". O arquivo errado é recusado na hora, na sua linha, com a correção (MA-25): "Este arquivo não é um áudio aceito. Envie mp3, m4a, wav, flac, ogg ou opus." / "Este arquivo tem 4,1 GB. O limite é 4 GB."
3. Cada linha mostra "Conferindo… 40%" enquanto o navegador calcula o SHA-256, e **Enviar** espera ("Conferindo arquivos…"). A API responde por arquivo (KBC-035): **"Já está no acervo: <título>"** com o link, sem envio (BR-2); **"Este envio passa da sua cota de 5 GB. Fale com um master para aumentar."** (BR-1, o dono não tem cota); **"Envio interrompido em 120 de 312 MB. Enviar continua de onde parou."**, com o título do primeiro envio travado; **"Este envio expirou. Envie de novo."** (24 h sem nenhuma parte nova, BR-3).
4. Campos, em uma coluna e com rótulo acima (MA-16, MA-17): **Título** em cada linha (preenchido com o nome do arquivo sem extensão, editável); para todos os arquivos, **Acervo** (o selecionado, trocável) e **Autor** (KBC-049, ADR 0030): combobox no padrão APG, sem pré-seleção (SL-28), com a ajuda "Escolha um autor do acervo ou digite um novo. Em branco, o áudio fica em "Outros autores"." As sugestões são os autores do acervo (num sub-acervo, os do acervo pai), até 8, o autor principal primeiro com ✦; quando o texto não é um autor, a última opção é **Cadastrar «nome»**. ↓/↑ percorrem, Enter escolhe, Escape fecha só a lista. Quando o texto não é um autor, a linha "Novo autor: «nome» será cadastrado neste acervo." (`aria-live`) avisa antes do envio e, se houver um autor parecido, "Você quis dizer «Mestre Gabriel»?" com **Usar «Mestre Gabriel»** (MA-27). O nome segue a regra da API (uma linha, até 60 caracteres, sem aspas nem « »): fora dela, o campo diz "O nome do autor deve ter uma linha e até 60 caracteres, sem aspas nem « »." e **Enviar** não envia; um nome recusado pela API aparece como "O nome do autor não foi aceito…", nunca como erro do arquivo. No celular a lista mostra poucas linhas e **Cancelar/Enviar** ficam fixos no rodapé do painel (UP-13). Um nome novo é cadastrado no acervo ao enviar.
5. **Enviar** manda até 3 arquivos ao mesmo tempo, cada linha com sua barra ("Enviando… 128 de 312 MB · 41%"), e **Cancelar envio**. Se a rede cai, a linha mantém a barra e diz "Sem conexão. O envio continua sozinho quando a rede voltar."; quando ela volta, o envio segue do último byte, sem clique. Quem usa leitor de tela ouve cada arquivo a cada 25 %. Sair da página durante o envio pede confirmação do navegador. Ao terminar, o painel fecha, as mídias aparecem no topo da lista em "Na fila" e o foco vai para a última (UP-01).
6. Se a conexão falhar, o envio tenta sozinho por cerca de dois minutos; depois, a linha diz "O envio parou: verifique a conexão e tente de novo." com **Tentar de novo**, mantendo os campos (MA-26) e continuando do último byte que a API tem. Recarregar a página, trocar de rota ou fechar com Escape não perde o envio: escolher o mesmo arquivo em até 24 h continua, até de outro aparelho. Só **Cancelar** e **Cancelar envio** removem o que estava pela metade (UP-04).

### Cota por pessoa (KBC-035)
Em Pessoas (T9), para quem tem `media-upload` e não é o dono, o campo **Cota de mídia (GB)**: vazio vale o padrão de 5 GB. Conta o espaço convertido (a estimativa de 30 MB/h até converter), sem as faixas.

### Editar informações (KBC-050)
- **Editar informações** fica no menu "⋯" da linha (T14, T16) e, como botão, na página do áudio (T15), só para quem enviou (com `media-upload`) e para masters. Na grade do T16 não há "⋯": a edição fica na página do áudio.
- Abre o mesmo painel do envio, já preenchido, com o foco no **Título**: **Título**, **Acervo** (os que a pessoa vê e abre) e **Autor** (o combobox do envio). Ao trocar o acervo, uma nota diz o que acontece: "Posições, marcadores e transcrição vão junto. Quem não vê este acervo deixa de ver o áudio."
- **Salvar** fecha o painel, atualiza a lista e a página e anuncia "Informações salvas". Um erro mantém o painel aberto com o que foi digitado e a mensagem (MA-26). Esc e **Cancelar** fecham e o foco volta ao "⋯".
- Ao mover, o áudio sai da lista (fica nela só se foi para um sub-acervo dela) e aparece "<título> foi movido para o acervo <nome>." com o link **Ver o acervo**; o foco vai para o título da página (UP-01).
- Em outro acervo de topo, o nome do autor é cadastrado no destino como no envio, e os falantes do áudio passam para a lista do destino.

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

## T15. Player (KBC-034, KBC-041 a KBC-046, KBC-038, KBC-039; vídeo no KBC-035)

**Objetivo:** ouvir uma palestra longa, lendo junto quando quiser, e voltar a um trecho sem procurar o minuto. **Contexto:** sentado, estudando no computador (fones, às vezes com anotações); no celular, ouvindo com a tela bloqueada ou trocando de app. **Sucesso:** voltar 15 s, mudar a velocidade e pular para uma frase sem errar o controle; retomar no dia seguinte, em outro aparelho, do ponto onde parou; nenhum controle depende só do mouse ou de gesto.

Referência de convenções (UP-05) e benchmark: [`docs/research/2026-10-28-player-benchmark.md`](../research/2026-10-28-player-benchmark.md). Convenções adotadas: voltar 15 s e avançar 30 s (assimetria dos apps de podcast), velocidade num menu, barra com tempo decorrido e restante, atalhos no padrão do YouTube só com o foco no player (WCAG 2.1.4), transcrição no padrão do Able Player e do Apple Podcasts.

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
- O player é um componente próprio sobre um único elemento de mídia sem o atributo `controls`: os controles nativos variam entre navegadores e não seguem os temas (DS-12). Ele serve áudio agora e vídeo depois (ADR 0025): acima dos controles há uma área de mídia, vazia no áudio (só a legenda) e com o vídeo no KBC-035, com a proporção reservada desde a primeira pintura, tela cheia (F) e picture-in-picture. Nada nos controles, na transcrição ou nos marcadores muda entre áudio e vídeo.
- **Mini-player persistente (KBC-041):** ao sair de `/midia/{id}` com o áudio tocando, ele continua. Uma barra de 64 px aparece no pé da área principal (no celular, acima da caixa de pergunta) com o título (link de volta ao player), ⟲15, ▶/❚❚, a barra de progresso fina e ✕ ("Fechar o player", que pausa e salva a posição). Assim dá para ouvir enquanto busca. O mini-player ocupa a última linha própria da área principal (não flutua sobre o conteúdo), então nunca esconde o elemento focado (WCAG 2.4.11).

### Controles (UP-13, MA-06, SL-20)
| Controle | Comportamento | Nome acessível |
|---|---|---|
| ▶ / ❚❚ (o maior, 56 px) | Tocar/pausar. Durante o carregamento, depois de 300 ms sem som (UP-14), vira um indicador de carregamento que continua clicável para pausar | "Tocar" / "Pausar" (muda com o estado) |
| ⟲15 / 30⟳ | Volta 15 s / avança 30 s, sem passar de 0 ou do fim | "Voltar 15 segundos" / "Avançar 30 segundos" |
| Barra de progresso | Padrão APG "Media Seek Slider": o foco fica no marcador (`role="slider"`). Um clique na trilha pula sem arrastar (WCAG 2.5.7); arrastar mostra o tempo junto ao marcador e pede o pulo no máximo a cada 100 ms; mostra o trecho já carregado em tom mais fraco; no desktop, passar o mouse mostra o tempo do ponto (só complemento, UP-09). Teclado: ←/→ 5 s, Shift+←/→ 10 s, PageUp/PageDown 60 s, Home/End início/fim. Em alto contraste, usa `currentcolor` | "Posição"; `aria-valuetext` "23 minutos e 10 segundos", com "de 1 hora, 2 minutos e 15 segundos" só ao focar; antes de carregar, "áudio ainda não carregado" |
| Tempos | À esquerda o decorrido; à direita o restante (`-39:05`); tocar no restante alterna para a duração total, e a escolha é lembrada | — |
| Velocidade | Botão com o valor ("1,5×") que abre um menu com 0,75× · 1× · 1,25× · 1,5× · 1,75× · 2×, o atual marcado com ✓ e em texto. Os atalhos sobem e descem um degrau, sem dar a volta. Vale para todas as mídias e é guardada na conta (KBC-041); é reaplicada a cada mídia (`defaultPlaybackRate` e `playbackRate`), com o tom da voz preservado | "Velocidade: 1,5 vezes" |
| CC (KBC-038) | Liga/desliga a legenda, `aria-pressed`; a escolha é lembrada | "Legendas" |
| Volume | Botão de mudo + controle deslizante horizontal. Aparece só quando o navegador deixa mudar o volume, o que o player testa ao abrir (no iPhone e no iPad o volume da página é só leitura, mesmo com trackpad); senão, vale o volume do aparelho | "Silenciar" / "Volume, 80%" |
| 🔖 Marcar (KBC-042) | Cria um marcador 2 s antes do ponto atual, sem pausar, e abre a nota em linha | "Marcar este trecho" |
| ☾ Timer (KBC-046) | Aparece só com o timer ligado, mostrando "Para em 14:59"; abre "Mais 5 minutos" e "Desligar timer" | "Timer para dormir: para em 14 minutos e 59 segundos" |
| ⋯ | "Copiar link deste minuto" (KBC-038), **Pulos** (voltar 5/10/15/30 s, avançar 10/15/30/45/60 s, KBC-043), **Encurtar silêncios** com o tempo economizado (KBC-044), **Destacar palavra a palavra** (KBC-045), **Timer para dormir** (5–60 min ou "No fim desta mídia", KBC-046) e "Atalhos de teclado" | "Mais opções" |

Os tempos usam `m:ss` abaixo de 1 h e `h:mm:ss` a partir de 1 h, em algarismos tabulares, para não tremer ao contar.

### Vozes e quem fala (KBC-064, KBC-065)
- **Painel "Vozes"**, abaixo dos marcadores, só para quem tem `media-edit`. Cada voz é uma linha: marca e "Voz N", tempo de fala, **Ouvir amostra da Voz N** (5 s do trecho mais longo, num elemento próprio: não mexe na posição; vira "Parar amostra da Voz N") e o campo **Quem é a Voz N?**.
- **Quem é a Voz N?** é um combobox no padrão APG, como o de autor: "Pergunta da plateia" primeiro, autor principal com ✦, falantes e autores do acervo (até 8), "Sem nome" quando a voz tem nome e **Cadastrar «nome»**. Escolher salva na hora ("Nome salvo."); sair sem escolher volta ao que estava. Nome vazio ou fora da regra (1 a 120 caracteres, uma linha, sem aspas nem « ») aparece no campo e nada é criado. Enter sem opção ativa só salva o que está escrito por inteiro: o nome exato ou um nome que ninguém da lista contém; texto igual ao atual não muda nada, e parte de um nome abre a lista (cadastrar fica a uma tecla, em ↑). Enquanto as listas chegam, o campo mostra "Carregando…" e não oferece cadastrar.
- **Juntar vozes:** "Juntar a voz [ ] com a voz [ ]" e **Juntar**; depois, "Voz 4 junta à Voz 2" com **Separar a Voz 4**, que desfaz (UP-07).
- **Separação nova:** com nomes na anterior, aviso "Confirme os nomes das vozes" e **Confirmar nomes**. Os nomes vêm pré-preenchidos quando ≥ 70 % do tempo da voz antiga cai na nova; quem só ouve lê "Falante não identificado" até a confirmação.
- **Falantes do acervo (N)**, recolhido: lista com **Editar** para renomear e dizer qual autor o falante é.
- **Sugestão por voz** (KBC-071), no painel "Vozes", sob a voz sem nome: "Parece ser Mestre Gabriel (semelhança alta)" ou "(semelhança média)", com **Aceitar** e **Recusar**. Nunca vira nome sozinha; sem perfil cadastrado, nada aparece.
- **Transcrição e legenda**, para `media-speakers` ou `media-edit`: o nome na troca de falante ("✦ Mestre Gabriel", "Pergunta da plateia"); voz sem nome é "Voz N" para quem edita e "Falante não identificado" para quem só ouve. A legenda prefixa o cue: "— ✦ Mestre Gabriel: …". **Mostrar quem fala** fica no menu ⋯, ligado por padrão e lembrado neste navegador.

### Faixas (KBC-066)
- Com `media-tracks`: lista **Faixas** abaixo do player (número, título, início e duração; a atual com `aria-current` e "tocando agora"), riscos altos na barra de progresso no começo de cada faixa (os marcadores continuam pontos), o título da faixa atual entre **Faixa anterior** e **Próxima faixa** (Shift+←/→ na página; sem faixas, essas teclas seguem andando 5 s) e no lugar do título no mini-player. `?track=3` abre pausado no começo da faixa 3. Sem a permissão, nada muda.
- Para `media-edit`: **Preparar áudio**, ou "Preparação parada no passo 3 · Continuar", ou "12 faixas aplicadas · Ver edição", levando à T20 (`/midia/{id}/faixas`).

### Atalhos de teclado (UP-09: todos também têm botão)
Ativos só na página do player, quando o foco está no player, na transcrição, no mini-player ou no corpo da página, e **nunca** com o foco em `input`, `textarea`, `select`, `[contenteditable]`, item de menu ou diálogo: Espaço ou K tocar/pausar · J voltar 15 s · L avançar 30 s · ←/→ 5 s · Shift+, e Shift+. diminuir/aumentar a velocidade · M silenciar · C legendas · B marcar este trecho · 0–9 ir para 0%–90% · ? lista dos atalhos. J e L seguem os pulos escolhidos (KBC-043). O diálogo "Atalhos de teclado" (com "Fechar" e Esc) tem a opção **Usar atalhos de uma tecla**, ligada por padrão e lembrada, que os desliga (WCAG 2.1.4). Os botões declaram `aria-keyshortcuts`. Um controle focado que usa uma tecla (as setas na barra de progresso e na transcrição) a consome, e o atalho global não age em dobro.

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
| Esperando dados | Indicador no botão principal só depois de 300 ms seguidos de espera e nunca durante um pulo pedido pela pessoa (sem piscar a cada pausa curta da rede); o tempo não anda | Pausar |
| Erro de rede ou do arquivo | "Não consegui carregar o áudio. Verifique a conexão." + **Tentar de novo**, que retoma do mesmo segundo (MA-26) | Tentar |
| Sessão expirada | Pausa e mostra "Sua sessão expirou. Entre de novo para continuar ouvindo." com **Entrar**; a posição já está salva | Entrar |
| Mídia removida / sem acesso | Tela de não encontrado ("Esta mídia não está mais no acervo ou você não tem acesso a ela.") | Voltar à Mídia |
| Ainda não pronta | O status da lista (T14) no lugar do player | — |
| Terminou | **Ouvir de novo** | Ouvir |
| Conteúdo extremo | 4 h de áudio: a barra continua precisa (1 px ≈ 9 s numa barra de 1.600 px; o teclado dá precisão de 5 s); título de 200 caracteres quebra em 2 linhas | — |

### Transcrição ao lado (KBC-038)
- Coluna de leitura (Source Serif 4, 65–75 caracteres) ao lado do player no desktop; no celular, abaixo dele, com o player fixo no topo ao rolar. Cada segmento mostra o tempo à esquerda ("12:34", algarismos tabulares) e o texto. A coluna pode ser recolhida (**Esconder transcrição** / **Mostrar transcrição**), e a escolha é lembrada.
- **Teclado sem dezenas de paradas:** a lista é um único ponto de Tab; dentro dela, ↑/↓ andam entre os segmentos, Home/End vão ao primeiro e ao último e Enter ou Espaço tocam dali (tabindex móvel).
- O segmento ativo tem `aria-current="true"`, fundo de destaque **e** uma barra lateral (UP-20). O acompanhamento o mantém visível sem rolagem brusca (com `prefers-reduced-motion`, sem animação). **Qualquer rolagem feita pela pessoa** (roda, toque, teclado, barra de rolagem) suspende o acompanhamento, que só volta quando ela clica **Voltar ao trecho atual** (aparece enquanto o trecho ativo está fora da vista), toca num segmento ou pula pelo player. A transcrição nunca rola contra quem está lendo.
- **Buscar na transcrição** (campo com rótulo no topo da coluna): destaca as ocorrências, mostra "3 de 12", ↑/↓ ou Enter/Shift+Enter andam entre elas, e **Tocar daqui** toca a ocorrência atual. Com a busca aberta, o acompanhamento fica suspenso.
- Selecionar texto oferece **Copiar com o link do minuto** (o trecho entre aspas, o título e o link `?t=`).
- **Palavra a palavra (KBC-045):** dentro do segmento ativo, a palavra falada ganha sublinhado grosso e peso maior (nunca só cor); clicar numa palavra toca dali, com a opção ligada ou desligada. As palavras não são paradas de Tab nem elementos próprios: a palavra é pintada com a CSS Custom Highlight API, como a busca, e o peso é desenhado, para o texto não sair do lugar (no Safari, só o sublinhado). Sem tempos de palavra, com as palavras ainda chegando ou fora do ar, fica o destaque do segmento e o clique vai ao início dele. Com a busca aberta, as ocorrências ficam por cima da palavra.
- **Aba Marcadores (KBC-042):** ao lado de "Transcrição", lista os marcadores da pessoa nesta mídia, por tempo, com a nota (ou o texto falado naquele ponto); clicar toca dali; editar a nota em linha; apagar com **Desfazer** por 8 s. As marcas também aparecem na barra de progresso. A tela Mídia ganha **Meus marcadores**, com os de todas as mídias.
- Baixa confiança: "Transcrição automática de baixa confiança: pode haver trechos errados." acima do texto, em tom de aviso (não vermelho, UP-19), sempre visível.
- Legenda sobre a área do player (fundo escuro translúcido, texto claro, contraste ≥ 4,5:1 em todos os temas), no máximo 2 linhas.

### Acessibilidade e toque (MA-01 a MA-07, MA-29, WCAG 2.2 AA)
- Alvos ≥ 44 × 44 px (≥ 48 px no celular); o botão principal tem 56 px e fica no centro, ao alcance do polegar (MA-06, MA-07).
- Foco visível com contraste ≥ 3:1 em todos os controles e segmentos; a ordem de Tab segue a ordem visual (player, depois transcrição).
- Nenhum anúncio a cada segundo: uma região `role="status"` fala só mudanças confirmadas ("Tocando", "Pausado", "Velocidade 1,5 vezes", "Legendas ligadas", "Posição 23 minutos e 10 segundos" depois de um pulo), junta pulos seguidos num anúncio e fica quieta enquanto a barra de progresso está focada (ela já fala). Erros usam a mesma região.
- Tamanhos em `rem`, para acompanhar o tamanho de fonte escolhido pela pessoa; `prefers-contrast` e cores forçadas respeitados.
- Nenhum controle só por gesto ou por passar o mouse (UP-09, SL-22); arrastar a barra tem a alternativa do teclado e dos botões ±.
- O estado é sempre também texto ou forma, nunca só cor (UP-20); as cores vêm dos tokens dos três temas.

### Fora do escopo e perguntas em aberto
- **Faixa (KBC-070):** para quem tem `media-subjects`, abaixo dos dados: "Assuntos:" com chips que abrem a busca filtrada por eles (texto simples para quem não tem a busca) e o resumo. Só aceitos.
- **Fora:** baixar o áudio, listas de reprodução e fila de próximos (entram com a Biblioteca, T16 a T19: KBC-053, KBC-054, KBC-056); faixas e capítulos no slider e na transcrição (fase B); compilados (fase C); vídeo (KBC-035 usa o mesmo player com a área de vídeo); editar a transcrição.
- Marcadores com nota, pulos configuráveis, encurtar silêncios, palavra a palavra e timer para dormir entraram por decisão do dono em 2026-10-28 (KBC-042 a KBC-046).
- **Precisa de teste com usuários** (UP-25): os rótulos ⟲15/30⟳ e o "Continuar de" são entendidos? O mini-player atrapalha a leitura dos resultados no celular? Entra no teste da fase 2 com 1 a 2 colegas (`docs/product/context.md`, ## Research).

### Editar uma faixa aplicada (KBC-073)

- **Página da faixa, para `media-edit`:** abaixo do cabeçalho, **Editar**, **Ajustar início e fim**, **Apagar faixa** (perigo) e "Histórico" (recolhido). Faixa apagada: **Restaurar faixa** junto do aviso. Com a edição da gravação reaberta: "Esta gravação está em edição." e o link para ela.
- **Editar faixa** (diálogo): Título, Descrição, Quem pergunta, Quem responde; "Aplicar o nome: só nesta faixa / em toda a gravação", quando o nome mudado é de um papel com voz; Assuntos (`media-classify`); "Sugerir de novo com IA" (`media-edit-ai`): custo, "Confirmar e sugerir", e cada sugestão com **Usar**. Conflito: mostra o título da outra pessoa e mantém o que foi escrito, com **Usar o da outra pessoa** e **Salvar o meu por cima**.
- **Ajustar início e fim** (`/midia/{id}/limites`): a barra do T20 numa faixa só, vizinhas visíveis e limitando, ±0,5 s, "Ouvir o início", "Ouvir o fim", **Salvar limites**, e "Recortando…", "Pronto". Corte falho: "Não foi possível recortar." com **Tentar de novo**. Conflito: a mudança da outra pessoa (título e limites), o ajuste continua na barra, **Usar o da outra pessoa** / **Salvar o meu por cima**.
- **Apagar faixa:** confirmação com o impacto ("3 pessoas ouviram esta faixa e 5 marcadores estão nela. Você pode restaurar em até 30 dias."). Playlists, favoritos e cópias offline entram na frase quando existirem.
- **Gravação:** "Faixas apagadas" com **Restaurar** e "restaura até dd/mm", só quando há alguma.
- **Biblioteca:** ⋯ na linha da faixa com as mesmas três ações.
- **Marcador movido:** "1 marcador foi movido para a gravação completa porque a faixa mudou", com **Ver a gravação** e **Entendi**, em "Meus marcadores" e na faixa.

## T16. Biblioteca (KBC-051, KBC-052, KBC-055, KBC-059; ⤓ do KBC-056)

**Objetivo:** navegar só na mídia, no modelo do "Your Library" do Spotify: continuar o que estava ouvindo, achar uma palestra (áudio ou vídeo) pelos filtros e chegar às próprias listas. **Contexto:** em casa no desktop, escolhendo o que estudar; no celular, retomando no trajeto. **Sucesso:** retomar a última palestra em 1 clique a partir da Biblioteca; achar uma palestra por autor e estado em até 3 ações (chip, chip, clique); nenhum controle depende de arrastar ou de passar o mouse.

Benchmark: [`docs/research/2026-10-29-media-library-benchmark.md`](../research/2026-10-29-media-library-benchmark.md). Convenções adotadas do Spotify (UP-05): filtros em chips no topo, ordenação num menu, alternância lista/grade, fixados no topo, "Recentes" lembrados; o que não serve a um acervo de estudo ficou fora (recomendações, social, anúncios).

### Onde fica
- Item **Biblioteca** na lateral, no lugar de **Mídia** (mesma posição, UP-05), só para quem tem `media-library`; quem só tem `media` continua com a lista T14. Rotas: `/biblioteca`, `/biblioteca/playlists/{id}` (T17), `/biblioteca/pastas/{id}`, `/biblioteca/autores/{acervo}/{autor}`, `/biblioteca/baixadas` (T19). `/midia` leva a `/biblioteca` com o acervo como filtro; o player continua em `/midia/{id}` (T15).
- No celular, **Biblioteca** fica no menu ☰ e ocupa a tela cheia, com o mini-player no pé (KBC-041). Sem rede, a lateral mostra só **Baixadas** (KBC-056).

### Layout
```
Desktop (≥ 1024 px)                                        Celular (< 1024 px)
┌──────────┬──────────────────────────────────────────┐    ┌────────────────────────┐
│ Lateral  │ Biblioteca                 [Enviar mídia] │    │ ← Biblioteca     🔍  ⋯ │
│ Buscar   │ [🔍 Buscar na biblioteca            ]     │    │ Continuar ouvindo  →   │
│ Biblio-  │ Continuar ouvindo                   ver ▸ │    │ ┌──────┐┌──────┐       │
│ teca •   │ ┌────────┐┌────────┐┌────────┐            │    │ │23:10 ││Vídeo │ ...   │
│ Baixadas │ │Palestra││Aula 3  ││Vídeo · │  (rola →) │    │ └──────┘└──────┘       │
│          │ │▶ 23:10 ││▶ 05:02 ││▶ 41:00 │            │    │ [Áudio][Vídeo][Não ouv]│
│          │ └────────┘└────────┘└────────┘            │    │ (chips rolam →)        │
│          │ Listas: 📌 ♥ Favoritas · 12 · 9:40        │    │ Listas                 │
│          │         📌 Curso de Cabala · 8 · 7:12     │    │ ♥ Favoritas  12 · 9:40 │
│          │         ▸ UDV (pasta, 3 playlists)        │    │ Curso de Cabala  8     │
│          │ Ouvidas recentemente      Limpar recentes │    │ Todas · 42 · Recentes ▾│
│          │ Todas · 42 mídias · 31 h                  │    │ ▶ Palestra de 1998     │
│          │ [Áudio][Vídeo][Não ouvidas][Em andamento] │    │   ✦ M. Laércio · 1:02  │
│          │ [Ouvidas][Favoritas][Baixadas][Autoria ▾] │    │   Continuar de 23:10   │
│          │ [Acervo ▾]     Ordenar: Recentes ▾  ☰ ▦   │    │ ...                    │
│          │ ☐ ▶ Título · ✦ Autor · Acervo · 1:02:15 · │    │ [mini-player]          │
│          │     Vídeo · Em andamento ━━━─ ♥ ⤓ ⋯       │    └────────────────────────┘
│          │ [mini-player]                              │
└──────────┴──────────────────────────────────────────┘
```

Hierarquia (UP-16): (1) **Continuar ouvindo**, a ação mais frequente; (2) a busca e as listas (Favoritas, playlists); (3) "Todas" com chips e ordenação; (4) "Ouvidas recentemente", recolhível no celular. No máximo 3 tamanhos de tipo (UP-17); o acento só no ▶ e no item ativo (UP-18).

### Cabeçalho e busca
- Título "Biblioteca" (h1) e, para quem tem `media-upload`, **Enviar mídia** (primário, SL-18), que abre o painel de envio do T14.
- **Buscar na biblioteca** (rótulo visível, SL-04; ✕ para limpar, SL-06; debounce 200 ms; as palavras ficam na URL, `?busca=`, para Voltar reencontrar o resultado): com texto na caixa, a tela é só o resultado (KBC-096).
  - **Resultado**: o primeiro conteúdo sob a caixa. "Continuar ouvindo", "Ouvidas recentemente", "Todas", chips, ordenação e visão somem desde a primeira tecla. Fica uma linha com a contagem ("3 resultados", "Mais de 200 resultados"), **Acervo ▾** e **Limpar filtros**; filtro em vigor sem controle na tela é dito ("1 filtro em uso"). A contagem é anunciada na região de status.
  - **Linha**: ▶ · título (link) · "Entrevista · faixa 3 de 23" (ou "Gravação completa · 23 faixas") · autor · duração · tempo (`8:15`) · frase com as palavras marcadas (até 240 caracteres ao redor do termo) · "baixa confiança" quando for. ▶ toca do trecho menos 2 s; o título abre o player nesse ponto, pausado. Cada faixa aparece uma vez, com seu melhor trecho.
  - **Ordem**: fala, depois título e autor, depois assunto. Gravação achada só pelo título é uma linha, não todas as faixas. Quem não tem `search` não tem a fala nem os resumos, que derivam dela: só título, autor e nome do assunto.
  - **Sem resultado**: "Nada encontrado para '…' na fala, no título, no autor ou nos assuntos." + dica de palavra inteira + **Limpar busca** (+ **Limpar filtros**, com filtro ativo).

### Continuar ouvindo e Ouvidas recentemente
- **Continuar ouvindo**: até 10 cartões em faixa horizontal com rolagem (setas ◂ ▸ no desktop, também pelo teclado; no celular, deslizar **e** "Ver tudo", UP-09). Cartão: capa gerada (iniciais do título sobre a cor do acervo), título em 2 linhas, autor, selo "Vídeo" quando for, barra de progresso com "Continuar de 23:10" em texto (UP-20) e ▶ que toca direto do ponto salvo. Some quando vazio.
- **Ouvidas recentemente**: lista compacta das últimas 50, com "há 2 dias"; **Limpar recentes** pede confirmação em linha (MA-27: "Limpar as mídias ouvidas recentemente? Suas posições, favoritas e marcadores continuam." · **Limpar** · **Cancelar**). Vazio depois de limpar: "Nada ouvido desde que você limpou."

### Listas (KBC-052, KBC-054, KBC-055)
- **Favoritas** primeiro ("♥ Favoritas · 12 mídias · 9:40"), depois os fixados (📌 e o texto "Fixada", até 4), as pastas (recolhíveis, `aria-expanded`, "UDV · 3 playlists") e as playlists; **Compartilhadas comigo** (KBC-058) por último, com "De <nome>".
- **Nova playlist** e **Nova pasta** no topo da seção; ordenação própria ("Recentes", "Adicionadas", "A–Z", "Personalizada"). Em "Personalizada", arrastar no desktop **e** **Mover para cima/baixo** no ⋯ de cada lista (UP-09, MA-02).
- **Autores** (KBC-059): link "Autores" abre a lista de autores com contagem; o nome do autor em qualquer linha leva à página dele.

### Todas: chips, ordenação e visão (SL-13, SL-15, SL-16)
- Contagem acima ("42 mídias · 31 h"), atualizada e anunciada em `aria-live="polite"` a cada filtro.
- Chips combináveis, cada um com estado em texto e `aria-pressed` (UP-20): **Áudio** · **Vídeo** (só aparecem quando o acervo tem os dois) · **Não ouvidas** · **Em andamento** · **Ouvidas** · **Favoritas** (KBC-052) · **Baixadas** (KBC-056) · **Autoria ▾**/autor (KBC-049) · **Acervo ▾** (com sub-acervos recuados, KBC-048). Os chips sem item no conjunto atual não aparecem (SL-16). Com filtro ativo, **Limpar filtros**.
- **Assunto ▾** (KBC-070, `media-subjects`): `select` entre Autoria e Acervo, lembrado na conta. Com um assunto, as linhas passam a ser as faixas ligadas a ele. Assunto que saiu aparece como "Assunto indisponível", para ser limpo.
- No celular, os chips rolam na horizontal **sem esconder opções** atrás da rolagem sem pista (MA-18): o último visível fica cortado pela metade e há **Filtros (3)**, que abre uma tela com todos, **Aplicar** fixo e **Cancelar** (SL-21).
- **Ordenar** (menu): Ouvidas recentemente (padrão) · Adicionadas recentemente · Título A–Z · Duração · Autor; na página do autor também "Mais antigas primeiro". A escolha, a visão e os filtros ficam na conta (KBC-051 BR-7).
- **Visão**: ☰ lista (padrão) / ▦ grade, botões com nome ("Ver em lista"/"Ver em grade") e `aria-pressed`.
- **Linha** (SL-17, DS-06): ▶ (toca direto), título (até 2 linhas), ✦ autor (link, KBC-059), acervo, duração (`1:02:15`, algarismos tabulares), selo "Vídeo", estado ("Não ouvida" omitido; "Em andamento" com barra e "Continuar de"; "Ouvida" com ✓ em texto), ♥, ⤓/estado de download, ⋯ (Tocar a seguir, Adicionar à fila, Adicionar à playlist, Marcar como ouvida/não ouvida, Baixar/Remover download, Ir para o autor, Copiar link). A linha toda abre o player (≥ 48 px, MA-01); os botões internos param a propagação e têm o título no nome acessível ("Favoritar Palestra de 1998").
- **Grade**: cartões de 160 px (desktop) e 2 colunas no celular, com a capa gerada, título em 2 linhas, autor e duração; as mesmas ações no ⋯.
- **Seleção múltipla**: caixa por linha (só na lista) e "Selecionar todas as 42"; com seleção, uma barra fixa "3 selecionadas · Marcar como ouvida · Marcar como não ouvida · Adicionar à playlist · Adicionar à fila · Baixar · Cancelar seleção".

### Variação: página do autor (KBC-059) e da pasta (KBC-055)
- Autor: "← Biblioteca", h1 com ✦ quando principal, acervo, "12 mídias · 9:40 · Você ouviu 3 de 12", **Tocar tudo** (primário) e **Aleatório**, depois "Continuar ouvindo" do autor e "Todas" com os mesmos chips (ordem padrão "Mais antigas primeiro").
- Pasta: h1 com o nome, "3 playlists · 21:30", **Tocar tudo**, a lista das playlists e ⋯ (Renomear, Apagar pasta com **Desfazer**: "Pasta apagada. As playlists voltaram para a Biblioteca.").

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Carregando | Esqueleto da faixa "Continuar ouvindo" (3 cartões) e de 8 linhas, na altura real | — |
| Biblioteca vazia, quem envia | "Ainda não há mídias nos seus acervos." + **Enviar mídia** | Enviar |
| Biblioteca vazia, quem não envia | "Ainda não há mídias nos acervos liberados para você." | — |
| Sem nada para continuar | A faixa "Continuar ouvindo" não aparece | — |
| Filtros sem resultado | "Nenhuma mídia com estes filtros." + **Limpar filtros** (SL-14) | Limpar |
| Erro ao carregar | "Não consegui carregar a Biblioteca." + **Tentar de novo**; o que já estava na tela continua | Tentar |
| Ação falhou (♥, marcar ouvida) | O estado volta e a região de status diz o que falhou ("Não consegui marcar como ouvida. Tente de novo.") | — |
| Sem rede (KBC-056) | A Biblioteca mostra só o chip **Baixadas** ligado e a nota "Sem conexão: mostrando só as mídias baixadas." | — |
| Sem permissão | O item **Biblioteca** não aparece; a rota direta mostra a tela de não encontrado | — |
| Conteúdo extremo | 2.000 mídias: lista virtualizada; títulos de 200 caracteres quebram em 2 linhas com reticências e o título inteiro no nome acessível; 500 playlists com busca na seção | — |

### Acessibilidade e toque (WCAG 2.2 AA, MA-01 a MA-07)
- A faixa "Continuar ouvindo" é uma lista (`role="list"`) com as setas como botões; nada só por deslizar (UP-09).
- Chips são botões com `aria-pressed`; o menu de ordenação é um botão com menu (APG "Menu Button"); "Filtros (3)" diz quantos estão ativos no nome.
- A lista é um único ponto de Tab por linha (a linha) mais os botões internos; com 2.000 itens virtualizados, o foco nunca cai num item não renderizado (a virtualização mantém o item focado).
- Alvos ≥ 44 × 44 px (≥ 48 px no celular); ♥ e ⤓ com nome que inclui o título; estado nunca só por cor (UP-20); `prefers-reduced-motion` respeitado nas faixas.

### Fora do escopo e perguntas em aberto
- **Fora:** recomendações ("parecidas", mixes, DJ), social (seguir, perfis públicos, Jam), capa enviada pela pessoa, link público de playlist (mídia só entre usuários do app).
- **Precisa de teste com usuários** (UP-25): "Biblioteca", "A seguir" e "Baixadas" são entendidos? A faixa "Continuar ouvindo" é achada no celular? Entra no teste da fase 2 com 1 a 2 colegas (`docs/product/context.md`, ## Research).

## T17. Playlist (KBC-054, KBC-055, KBC-057, KBC-058)

**Objetivo:** montar e ouvir um percurso de estudo na ordem escolhida. **Sucesso:** criar uma playlist com 3 mídias em menos de 2 minutos; reordenar só com o teclado; tocar do primeiro item não ouvido em 1 clique.

### Layout
```
Desktop                                                    Celular
┌──────────┬──────────────────────────────────────────┐    ┌────────────────────────┐
│ Lateral  │ ← Biblioteca                              │    │ ← Biblioteca        ⋯  │
│          │ [capa]  Curso de Cabala                   │    │ [capa] Curso de Cabala │
│          │         8 mídias · 7:12 · faltam 5:40     │    │ 8 mídias · 7:12        │
│          │         "Aulas na ordem do Mestre…"        │    │ [▶ Tocar] [⤮] [⤓] [⋯] │
│          │ [▶ Tocar] [⤮ Aleatório] [⤓ Baixar ◯] [⋯] │    │ 🔍 Buscar na playlist  │
│          │ 🔍 Buscar na playlist                      │    │ 1 ⋮ Aula 1   ✓ Ouvida  │
│          │ #  Título                 Autor  Dur.  ⋯  │    │ 2 ⋮ Aula 2   23:10     │
│          │ 1 ⋮ Aula 1 · ✓ Ouvida      ✦ M.L. 52:10 ⋯ │    │ ...                    │
│          │ 2 ⋮ Aula 2 · Continuar 23:10     48:03 ⋯  │    │ [mini-player]          │
└──────────┴──────────────────────────────────────────┘    └────────────────────────┘
```
- Cabeçalho: capa gerada (mosaico das 4 primeiras ou iniciais), nome (h1), "n mídias · duração · faltam h:mm" (só o não ouvido), descrição (até 3 linhas, **Ver mais**). **Tocar** (primário) começa do primeiro item não ouvido; **Aleatório** liga o embaralhar do KBC-053; **Baixar** é uma chave (`role="switch"`, KBC-057) com "1,2 GB · faltam 300 MB"; ⋯: Renomear, Editar descrição, Mover para pasta, Fixar, Compartilhar (KBC-058), Apagar.
- Linhas numeradas com ⋮ (alça de arrastar, só complemento) e ⋯ com **Mover para cima**, **Mover para baixo**, **Mover para o topo**, Remover da playlist (com **Desfazer** por 8 s), mais as ações da linha da Biblioteca. Mudança de ordem anunciada ("Aula 3 movida para a posição 1 de 8").
- **Compartilhada** (KBC-058): selo "Compartilhada" e "De <nome>" para quem recebeu; quem só ouve não vê alça nem remover; cada linha diz "Adicionada por <nome>" quando a playlist tem mais de um editor.
- **Compartilhar** (diálogo): campo **E-mail da pessoa** (rótulo acima, MA-16), rádios **Pode ouvir** (marcado) / **Pode editar** (MA-19), **Convidar**; a resposta é sempre a mesma (KBC-058 BR-5); a nota "As pessoas só ouvem as mídias dos acervos que já podem ver."; a lista de pessoas com o papel (seleção) e **Remover acesso** (com Desfazer).

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Carregando | Esqueleto do cabeçalho e de 6 linhas | — |
| Vazia | "Esta playlist ainda está vazia. Adicione mídias pelo ⋯ de qualquer mídia ou:" + **Ir para a Biblioteca** | Ir |
| Itens ocultos | "1 mídia oculta: você não tem mais acesso a ela." sob o cabeçalho | — |
| Mudou em outro aparelho | "A playlist mudou em outro aparelho. Mostramos a ordem atual." (status) | — |
| Erro ao salvar ordem | A ordem volta e "Não consegui salvar a nova ordem. Tente de novo." | — |
| Sem rede | Só leitura: "Sem conexão: as playlists não podem ser editadas agora." (KBC-057) | — |
| Apagada / sem acesso | Tela de não encontrado ("Esta playlist não existe mais ou não foi compartilhada com você.") | Voltar à Biblioteca |
| Conteúdo extremo | 1.000 itens virtualizados; nome de 100 caracteres em 2 linhas | — |

## T18. A seguir (KBC-053)

**Objetivo:** ver e ajustar o que toca depois, sem perder o ponto atual. **Sucesso:** tocar uma mídia a seguir em 2 ações (⋯ → Tocar a seguir); reordenar e remover só com o teclado.

- Abre pelo botão **A seguir** (ícone de lista + texto no desktop; no celular, no ⋯ do player e tocando no título do mini-player). No desktop é um painel à direita (substitui a coluna da transcrição enquanto aberto, com **Fechar** e Esc); no celular, tela cheia com "← Voltar".
- Três grupos com títulos (h2): **Tocando agora** (título, autor, tempo); **Na fila** (n) com **Limpar fila** (com Desfazer); **A seguir de: <lista>** (contexto). Cada item com ⋮ (arrastar, complemento), ⋯ (Mover para cima/baixo, Remover) e a duração.
- Controles do player (T15) ganham ⏮ **Anterior** e ⏭ **Próxima** dos dois lados do ▶ (40 px; ▶ continua o maior, 56 px), **Aleatório** (`aria-pressed`, "Aleatório ligado") e **Repetir** (botão de 3 estados com o texto no nome: "Repetir: desligado / lista / esta mídia"; o ícone de "esta mídia" tem o "1"). Atalhos Shift+N e Shift+P (com as regras de atalho do T15). O mini-player ganha ⏭.
- Fim da lista com **Continuar com a próxima da lista** desligado: "A seguir: <título>" + **Tocar**. Mídia pulada: aviso na região de status ("Pulamos '…': ela não está mais disponível para você.").
- Estados: fila vazia ("Nada na fila. Use 'Tocar a seguir' ou 'Adicionar à fila' no ⋯ de qualquer mídia."); 500 itens (virtualizada; "A fila chegou a 500 mídias." ao passar).
- Acessibilidade: a lista é `role="list"`; depois de remover, o foco vai ao item seguinte (ou ao anterior no fim), nunca ao topo (WCAG 2.4.3); as mudanças são anunciadas uma vez.

## T19. Baixadas (KBC-056, KBC-057)

**Objetivo:** ouvir sem rede e controlar o espaço do aparelho. **Contexto:** celular, antes de sair de casa (baixar) e no trajeto sem sinal (ouvir). **Sucesso:** baixar uma palestra em 2 ações (⤓ → confirmar); abrir e tocar uma baixada no modo avião em ≤ 3 s; saber quanto espaço sobra sem abrir outra tela.

### Baixar (⤓)
- ⤓ **Baixar** na linha, no player (⋯ e botão próprio no celular) e no menu ⋯. Áudio: começa na hora, com o tamanho no aviso ("Baixando 'Palestra de 1998' · 15 MB"). Vídeo: um menu com **Vídeo (720p) · 400 MB** e **Só o áudio · 30 MB** (a escolha mais leve primeiro, sem pré-seleção enganosa, SL-28).
- O ícone da linha mostra o estado em forma e texto (UP-20): ⤓ "Baixar" · anel de progresso com "41%" · ✓ "Baixada" · ⚠ "Falhou". O primeiro download pede o armazenamento persistente do navegador (sem tela nossa antes; se negado, a nota em Baixadas).

### Tela Baixadas
```
Celular (390 px)
┌──────────────────────────────┐
│ ← Biblioteca   Baixadas      │
│ Neste aparelho: 1,3 de 5 GB  │
│ ━━━━━━─────────── 3,1 GB livre│
│ Remover depois de ouvidas ◯  │
│ Baixando (1)                 │
│ Aula 3 · 41% · 120 de 290 MB │
│   [Pausar] [Cancelar]        │
│ Curso de Cabala (lista) ✓    │
│ Palestra de 1998 · 15 MB  ⋯  │
│ ...                          │
│ Aparelhos (2 de 5)           │
│ iPhone de Diogo (este)  ✎    │
│ Chrome no Mac   [Remover]    │
│ [Remover todas as baixadas]  │
└──────────────────────────────┘
```
- Topo: espaço "Neste aparelho: 1,3 de 5 GB" com a barra e o livre real do aparelho (`storage.estimate`), **Mudar limite** (seleção 1–20 GB até o máximo que o master liberar). Abaixo, **Remover baixadas depois de ouvidas** (`role="switch"`, desligado, KBC-057).
- Grupos: **Baixando** (com **Pausar**/**Continuar**/**Cancelar** e "Na espera"), **Listas baixadas** (KBC-057: "Curso de Cabala · Tudo baixado" ou "Faltam 2: sem espaço neste aparelho." com **Ver o que falta**) e as mídias (título, autor, "Vídeo · 720p" ou "Só o áudio", tamanho, "Expira se ficar 30 dias sem internet"). ⋯ por mídia: Tocar, **Remover do aparelho** (com Desfazer enquanto o arquivo ainda não foi apagado: 8 s).
- **Aparelhos (n de 5)**: nome editável em linha, "(este)", último contato; **Remover** pede confirmação em linha ("Remover 'Chrome no Mac'? As mídias baixadas nele param de tocar no próximo contato." · **Remover** · **Cancelar**).
- **Remover todas as baixadas** (secundário de perigo) com confirmação em diálogo (UP-07), que diz o espaço liberado.
- Avisos fixos quando se aplicam (tom de aviso, não vermelho, UP-19): "O navegador pode apagar as mídias baixadas se faltar espaço." (+ no iPhone: "Adicione o app à tela de início para guardar com mais segurança.") · "Os downloads só andam com o app aberto."

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Nada baixado | "Nenhuma mídia baixada neste aparelho. Use ⤓ numa mídia para ouvir sem internet." + **Ir para a Biblioteca** | Ir |
| Sem rede | Banner "Sem conexão. Só as mídias baixadas estão disponíveis." no topo do app; Baixadas e o player funcionam; as outras telas mostram o mesmo texto com **Ir para Baixadas** | Ir |
| Licença expirada (30 dias) | Na mídia: "Conecte-se à internet para continuar ouvindo." e ▶ desabilitado com a explicação | — |
| Revogada | Aviso uma vez: "'…' foi removida das Baixadas: <motivo>." (sem acesso ao acervo · mídia removida · permissão retirada · aparelho removido) | — |
| Sem espaço | "Este download passa do limite de 5 GB deste aparelho. Remova algo em Baixadas ou baixe só o áudio (30 MB)." | Ver Baixadas |
| Limite de aparelhos | "Você já baixa mídias em 5 aparelhos. Remova um em Baixadas para usar este." + a lista | Remover |
| Parte apagada pelo navegador | "Precisa baixar de novo" + **Baixar de novo** | Baixar |
| Falha de rede no download | "O download parou: verifique a conexão. Ele continua de onde parou." + **Continuar** (MA-26) | Continuar |
| Nova versão do app | "Nova versão disponível" + **Atualizar**; nunca recarrega sozinho tocando | Atualizar |

### Acessibilidade
- O progresso é um `progressbar` com `aria-valuetext` ("41%, 120 de 290 megabytes"); a região de status anuncia só a cada 25% e no fim ("'Aula 3' baixada."), nunca a cada parte.
- Chaves com `role="switch"` e o estado em texto; confirmações em linha com o foco em **Cancelar** (MA-27); alvos ≥ 48 px no celular.

## T20. Perfis de voz (KBC-071, ADR 0032)

**Objetivo:** sugerir o nome de quem fala só para quem autorizou. **Sucesso:** nenhuma voz é escolhida antes do consentimento; revogar apaga na hora.

- Seção de ⚙ Configurações, depois de Transcritores. Só aparece para um **master**: "Cadastrar perfis de voz" vem com o papel, como as outras funcionalidades, sem autorização pelo nome (decisão do dono, 2026-11-04). Em Pessoas e permissões, a caixa aparece marcada e travada para um master; a um membro ela não é oferecida, nem nos perfis de convite.
- **Acervo** (só acervos de topo; um sub-acervo usa os perfis do pai, BR-4), lista **Perfis deste acervo** (pessoa, estado em palavras, "Autorizado por … em dd/mm/aaaa", **Revogar**), **Cadastrar perfil**.
- **Cadastrar:** primeiro a pessoa e o consentimento. Texto em destaque (borda, no corpo da tela), com finalidade, guarda e revogação, e **Copiar texto**; "Quem é" (viva ou falecida; falecida troca o texto e pede quem responde pela obra e em que qualidade); data; meio; prova (documento ou texto do aceite); caixa de confirmação desmarcada. **Continuar** só passa com tudo isso, e só então aparecem as vozes já nomeadas, com o tempo de fala. **Calcular perfil** exige 30 s de fala no total.
- **Revogar:** pergunta no lugar, foco em **Cancelar**; "Revogar e apagar" (perigo). Depois, o foco vai ao título da lista e o status diz o que aconteceu.
- **Perfis e consentimentos**, só para o dono: cada consentimento (pessoa, acervo, quem autorizou, quando, meio, finalidade, versão do texto, quem registrou), "Revogado em …" ou "Em vigor", sugestões feitas, aceitas e recusadas, e **Baixar a prova do consentimento**.

| Estado | Mostra |
|---|---|
| Vazio | "Nenhum perfil neste acervo." |
| Sem transcritor marcado | "Nenhum transcritor ligado trata perfis de voz; …" |
| Calculando / Pronto / Precisa calcular de novo | em palavras; o último com **Calcular de novo** |
| Sem voz nomeada | "Esta pessoa ainda não tem voz nomeada em nenhuma gravação." |
| Erro ao carregar | "Não consegui carregar os perfis." + **Tentar de novo** |
| Consentimento recusado (422) | volta ao consentimento: "O consentimento não foi aceito. Confira os dados." |
| Lista de revogações perdida ou exposta | aviso em alerta com o que houve e o passo do dono (runbook, seção 11); somem **Cadastrar perfil** e **Calcular de novo**; **Revogar** fica |
| Revogação que não entrou na lista | "O consentimento foi revogado e o perfil foi apagado, mas a lista de revogações não foi gravada…"; aviso com o passo do dono até o próximo arranque |

Nenhuma tela mostra impressão de voz nem o número da semelhança.

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

## T20. Preparar áudio (passos 1 e 2 no KBC-072; 3 e 4 no KBC-066)

**Passos 1 e 2** (rota `/midia/{id}/preparar`; arquivo novo, no painel do T14). O pedido completo está em [`KBC-072`](../backlog/KBC-072-upload-with-editing-choices-and-live-progress.md). Como foi construído:

- **Indicador:** o mesmo componente nos três lugares, com "O próximo passo fica disponível quando o processamento terminar." por extenso; em telas estreitas, "2/4 Processar" e "Ver os passos".
- **Passo 1:** "O que fazer com este áudio", com opção desativada focável e o motivo por extenso; sem valor estimado não há opção paga. Áudio já enviado: **Preparar áudio** na página dele, só com o que falta.
- **Passo 2:** etapas e vozes à esquerda, faixas à direita (≥ 60rem); no celular, uma coluna. Todas as linhas são pintadas: com 200 faixas a rolagem segue em 60 fps; se pesar num celular fraco, o caminho é uma lista virtual.
- **Dinheiro:** o clique em **Enviar** com a opção paga marcada vale pelo valor mostrado. A etapa começa uma vez, reavalia e reserva só nessa hora; acima de 1,25 × o valor visto, ou de um teto, não roda e a tela diz o valor. Falha nunca repete sozinha: só "Tentar de novo", que mostra o custo.
- **Continuar:** "Preparação parada no passo N · Continuar" na lista, na biblioteca e na página do áudio.
- **Vários arquivos (KBC-035):** as escolhas valem para todos ("O que fazer com estes áudios"); as estimativas somam as durações dos que vão com elas, e sem a duração de um deles, ou com mais de 24 h somadas, não há estimativa nem opção paga. Cada arquivo leva sua parte do valor visto, pela duração. Depois de um arquivo enviado, vai ao passo 2; depois de vários, fica na lista, com "Preparação parada no passo N · Continuar" em cada um. Repetidos e recusados não contam. Durante o envio as opções saem da tela, para as barras de cada arquivo ficarem à vista, e voltam se o envio parar.
- **Envio retomado (KBC-035):** o item mantém o plano do primeiro envio; o painel diz "O que continua de um envio anterior mantém as escolhas daquele envio." e, se só houver retomadas, esconde as opções. O passo 2 abre pelo plano que está no servidor.

**Passos 3 e 4:** rota `/midia/{id}/faixas`. O pedido completo, com a tabela de estados, está em [`KBC-066`](../backlog/KBC-066-mark-tracks-and-play-by-track.md). Como foi construído:

- **Desktop (largura útil ≥ 60rem):** indicador de passos, barra de ferramentas (Nova faixa aqui, Desfazer, Refazer, zoom, −0,5 s/+0,5 s), Propor faixas com IA, visão geral, detalhe; abaixo, a lista à esquerda e a transcrição à direita; rodapé fixo com "12 faixas · 2 com aviso" e **Aprovar faixas**.
- **Celular:** "3/4 Validar faixas"; a mesma ordem, com "N faixas" e "Transcrição" em abas no lugar da folha que sobe (assim a lista nunca cobre as alças).
- **Lista:** um ponto de Tab, ↑/↓ entre as linhas; campos e ações só na linha selecionada (é o que mantém 200 faixas leves e o Tab curto).
- **Enquanto a IA propõe:** as faixas aparecem conforme cada janela termina, sem alças nem edição, até a análise acabar.
- **Dividir aqui** usa o cursor (um clique no detalhe, numa palavra ou no tempo da transcrição); fora dos 5 s de cada lado, vai ao ponto válido mais próximo.


### Assuntos, passo 4 (KBC-069)

Com `media-classify`, abaixo do resumo do passo 4, a seção **Assuntos** lista as faixas aprovadas. Cada linha tem número e título à esquerda e, à direita, a coluna de assuntos; abaixo de 900 px a coluna empilha.

- **Chips aceitos:** nome e "×" ("Remover assunto Cabala"). Sumido do acervo: ⚠ e "Assunto não encontrado no acervo", com borda de perigo; o texto é o sinal, não a cor.
- **Chips sugeridos:** borda tracejada, rótulo "Sugerido", "Aceitar" e "Recusar" ("Aceitar sugestão Cabala"). Assunto novo: "Novo assunto: «nome»", criado só ao aceitar. Com mais de uma sugestão, "Aceitar todas as sugestões desta faixa".
- **Adicionar assunto:** combobox como o de autor; lista conceitos e assuntos livres e oferece "Criar assunto «nome»" quando o nome não existe sem acento e sem maiúscula.
- **Limite:** o sexto é recusado com "Até 5 assuntos por faixa".
- **Resumo:** campo editável, salvo ao sair dele; o sugerido aparece à parte, com "Aceitar resumo" e "Recusar resumo".
- **Sugerir assuntos com IA** (também `media-edit-ai`): "Custa cerca de US$ …", "Confirmar e sugerir" e "Cancelar". Uma sugestão concluída por aprovação; depois dela o botão some e fica "Custou …". Falha: "Não foi possível sugerir." com o motivo e "Tentar de novo". Teto: "O teto mensal da mídia foi atingido.", sem confirmar.
- **Edição reaberta (passo 3):** só a dica "Os assuntos voltam depois de aprovar. Faixas mantidas guardam os seus."
- **Página da faixa:** com `media-classify`, assuntos e resumo só para leitura. Para quem ouve, no KBC-070.

## T21. Termos da transcrição e "Transcrever de novo" (KBC-040)

Configurações → **Termos da transcrição**: só masters, onde a mídia está ligada, logo depois de Transcritores.

- **Topo:** para que serve a lista, que ela vale para as próximas transcrições e que o que já foi transcrito só muda com "Transcrever de novo"; depois o uso ("180 de 224 do limite do transcritor") com uma barra, e a versão atual.
- **Adicionar termos:** um por linha; colar vários funciona. Repetido fica de fora, com aviso.
- **Lista:** uma linha editável por termo, com ×. Nada é salvo antes de **Salvar lista**; **Descartar mudanças** aparece quando há mudança.
- **Limite:** acima de 224, "A lista passou do limite do transcritor (231 de 224). Remova alguns termos." O servidor conta, porque o vocabulário do Whisper não vai ao navegador.
- **Conflito:** quando outra pessoa salvou antes, a edição fica na tela, com **Recarregar**.
- **Versões da lista:** fechado por padrão; versão, termos, data e autor.

Player (T15), só masters: **Transcrever de novo** abaixo de "Esconder transcrição", com confirmação em linha e o foco em **Cancelar**. Enquanto refaz, quem vê a mídia lê "Retranscrevendo…" ou "Retranscrevendo · aguardando o transcritor", e o texto, as legendas e a busca continuam os atuais. Uma tentativa que falha diz, a masters, "A nova transcrição falhou. O texto atual foi mantido." O painel da transcrição mostra a masters "Feita com a lista de termos v3 (28/10/2026)".

---

## T22. Trecho da faixa citado na pesquisa (KBC-099; estado da publicação no KBC-100; ADR 0035)

**Objetivo:** da citação de uma faixa numa resposta da IA, ler a transcrição no trecho citado e ouvi-lo dali. **Sucesso:** o trecho está destacado e visível sem rolar, e um toque em **Tocar** ouve de 2 s antes dele.

### Na resposta (emenda da T4)
- A citação de uma faixa é `[n]` como a de um texto; o leitor de tela ouve "Fonte n, faixa <título>, aos 8 minutos e 15 segundos".
- Em **Fontes**, o chip da faixa: **"♪ <título da faixa> · <gravação> · 8:15"**, no grupo de autoria dela (KBC-020), ao lado dos textos. O ♪ vem com texto ("Faixa de áudio" para leitores de tela), nunca só ícone (UP-20). Título longo trunca em 1 linha com o completo no `title`; no celular, a gravação vai para uma segunda linha do chip. Com mais de um trecho da mesma faixa citado, o chip mostra o primeiro minuto e "+2 trechos"; cada `[n]` no texto abre o seu.
- Fonte "atualizando" (KBC-100): o chip ganha "· atualizando" em texto discreto; o trecho é o que estava na pesquisa.

### Layout
```
Desktop (≥ 1024 px), painel de leitura à direita (o da faixa usa 48rem em vez de 40rem, para o player caber ao lado):
┌───────────────────────────── painel ─────────────────────────────┐
│ ♪ Faixa de áudio · 8:15                               ✕ Fechar   │
│ O que é o ritmo?                    (título, recebe o foco)      │
│ Palestra de 12/03/2017 · faixa 3 de 12 · ✦ Mestre Laércio        │
│ ⚠ transcrição automática de baixa confiança (só quando for)      │
├──────────────── transcrição ───────────┬──────── player ──────────┤
│ 7:58  … texto anterior …               │  [capa/onda]             │
│ ▌8:15 texto do trecho citado, em       │  ▶ Tocar   8:13 / 9:28   │
│ ▌     destaque (fundo + barra lateral) │  ━━━━━━━●━━━  velocidade │
│ 8:40  … texto seguinte …               │  Abrir na página da faixa│
│ (rola só a lista; "Voltar ao trecho")  │  (preso no alto)         │
└────────────────────────────────────────┴──────────────────────────┘
Celular (< 1024 px; 390 px): tela cheia, uma coluna: cabeçalho → player compacto preso
no alto (▶, tempo, barra de busca, velocidade) → transcrição abaixo, rolando.
```
- O player fica **ao lado** da transcrição no desktop (coluna de 16rem) e **acima** dela no celular, sempre visível enquanto a transcrição rola (o pedido do dono: "ao lado, mostre um player").
- O trecho citado usa o destaque `transcript-passage` (o mesmo da busca "Na fala"), mais uma barra lateral de 3 px para não depender da cor (UP-20, `forced-colors` ok). A palavra falada usa o destaque do KBC-045.
- A lista rola até o trecho no terço superior assim que abre (rolagem explícita; não depende do acompanhamento da fala). Com `prefers-reduced-motion`, a rolagem é instantânea.

### Fluxo
1. Clique ou Enter numa citação ou chip de faixa → o painel abre (ou troca de conteúdo, com "← Voltar" se havia um documento) com o título focado (`preventScroll`).
2. O player carrega a faixa em **trecho − 2 s, pausado**; **Tocar** é o primeiro controle depois do título na ordem de Tab. Nada toca sozinho.
3. Tocar → o áudio sai de 2 s antes, a fala atual e a palavra falada se destacam e a lista acompanha; rolar à mão para de acompanhar até "Voltar ao trecho atual" (KBC-038).
4. Clicar numa fala ou palavra toca dali (KBC-038).
5. **Abrir na página da faixa** leva a `/midia/:id?t=<s>`; **✕** ou Esc fecha, a reprodução continua no mini-player e o foco volta à citação clicada.

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Carregando | Cabeçalho (veio da fonte) + esqueleto da transcrição + bloco reservado do player | — |
| Sucesso | Transcrição no trecho + player pausado em −2 s | Tocar, ler, abrir a página |
| Trecho sem tempo resolvido (fonte antiga) | Transcrição do começo, player em 0:00, sem destaque | Tocar |
| Faixa editada depois da resposta | O trecho guardado ainda cai na faixa: destaca a fala nesse tempo; senão, "O trecho citado mudou desde a resposta. Mostrando o começo da faixa." | Tocar |
| Faixa arquivada, apagada ou sem acesso | "Esta faixa não está mais disponível." | Fechar |
| Áudio ainda não pronto | Transcrição + "Este áudio ainda não está pronto para ouvir." no lugar do player | — |
| Erro de rede | "Não foi possível abrir a faixa." | Tentar de novo |
| Transcrição muito longa (> 2 h) | Lista virtualizada a partir do trecho | — |

### Estado da publicação (KBC-100, página da faixa para `media-edit`; Transcritores para masters)
- Linha sob o título: **"Pesquisa com IA: Na pesquisa"**, **"Atualizando na pesquisa"**, **"Aguardando o Mac do dono (desligado desde 14:02)"**, **"Falhou: <motivo>"** com **Tentar de novo**, ou **"Fora da pesquisa: <motivo>"** (acervo sem pasta no kb; teto mensal da mídia). Texto com ícone, nunca só cor; mudança anunciada em `role="status"`.
- Transcritores: o transcritor ganha a opção **Publica no acervo** (como "Separa vozes") e a contagem "12 faixas aguardando publicação · última publicação 14:32".

### Acessibilidade e toque (WCAG 2.2 AA, MA-01 a MA-07)
- O painel é `role="dialog"`, `aria-modal="false"` no desktop, rotulado pelo título; no celular, a conversa fica `inert` (como o T3).
- Alvos ≥ 44 px no celular; a barra do player não depende de arrastar (setas ←/→ e os botões de pulo, KBC-041).
- A lista de falas é um só ponto de Tab com setas (KBC-038); o trecho citado tem `aria-current="true"` até tocar outra fala.
- 390 px: nenhuma rolagem lateral; texto da fala quebra; o tempo fica numa coluna de 3,5rem.

### Fora do escopo e perguntas em aberto
- O Markdown do vault nunca é mostrado. Vídeo segue no KBC-075.
- Pergunta ao dono (padrão adotado): o player abre pausado ("pronto para tocar"), não tocando como o painel da busca "Na fala".

*Emenda 2026-11-05 à T3 (KBC-101):* o "Veja também" pode trazer faixas ligadas pelo `kb link`: "♪ <título da faixa> · <gravação>", que abrem a T22 no começo, com "← Voltar". *À T4 (KBC-101):* a cobertura conta as faixas à parte: "2.700 documentos no conjunto (145 faixas de áudio)" e "· 412 analisados pela IA (30 faixas)".

---

## T30 — Fila de processamento (`/fila`, KBC-090)

Quem tem `media-upload` vê o que está sendo processado nos acervos que enxerga: entrada "Fila" na barra lateral, com contagem enquanto algo roda, e bloco na Biblioteca. Enviar vários arquivos leva para cá; um arquivo com plano continua indo para o passo 2.

Seções: **Precisa de você** (falha, "Validar faixas", "Concluir", "Continuar"), **Agora** e **A seguir**, com etapa em palavras, barra, posição e "Depois: …". Transcritor desligado: "Aguardando o transcritor". O "Tentar de novo" da etapa paga leva a `/preparar`, onde o valor aparece antes do clique. Lê a cada 5 s só com algo ativo e aba visível.

A Biblioteca segue o acervo selecionado, com "Todos os acervos" como escolha; o cabeçalho nomeia o que a página mostra (KBC-091). Nos passos 2 e 3, cada voz tem "Aceitar", "Corrigir" e "Recusar"; o nome dado chega aos títulos e resumos escritos pela IA.
