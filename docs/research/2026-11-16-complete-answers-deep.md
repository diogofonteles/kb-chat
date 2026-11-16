# Resposta completa e correta no Profundo — análise e proposta (2026-11-16)

Pedido do dono (chat, 2026-11-16): a Pesquisa com IA, a partir do modo Profundo, deve devolver sempre uma resposta **completa** (tudo o que o acervo tem de importante sobre o assunto) e **correta** (baseada no acervo), sem depender de o estudante conhecer o acervo para saber se falta algo.

## 1. Como funciona hoje (fatos medidos)

**Acervo Hermetismo:** 2.957 documentos (2.947 textos e 10 mídias), 128 MB de texto (≈ 32 milhões de tokens). 168 documentos têm mais de 100 KB, ou seja, livros inteiros num documento só.

**O que o kb produz (`kb classify`, `kb link`).** Por **documento**:
- gênero, profundidade e relevância;
- conceitos;
- entidades;
- 6 perguntas;
- um resumo de uma frase;
- ligações para as páginas de conceito.

Os conceitos são 39 páginas largas, e uma página de conceito tem só o critério e os sinônimos (`stage: stub`), sem síntese nenhuma:

| Conceito | Documentos marcados |
|---|---|
| Consciência e Mente | 1.943 (66 % do acervo) |
| Cosmologia Espiritual e Metafísica | 1.171 |
| Hermetismo e Filosofia Hermética | 643 |

**O que a IA faz no Profundo:**
- tem até 15 passos de ferramenta, e **a IA decide** o que buscar e o que ler;
- ferramentas: busca por sentido (ranking, limitada a 20 candidatos por sub-busca no QMD, ver KBC-120), `find_text` (grep completo, sem limite), filtros por assunto, autor e origem, e leitura de documentos.

**Onde a completude se perde:**
1. **Granularidade.** A classificação é do documento, não do trecho. O capítulo sobre a lei do ritmo dentro de um livro de 255 KB não aparece em nenhuma etiqueta: o livro inteiro tem um resumo de uma frase e 3 conceitos.
2. **Mapa grosso.** Um conceito com 1.943 documentos não guia a IA a lugar nenhum. Não existe o nível "Hermetismo → Sete Princípios → Ritmo", nem os sinônimos do assunto ("fluxo e refluxo", "pêndulo", "lei da periodicidade").
3. **Decisão na hora e com orçamento curto.** Em 15 passos a IA lê de 10 a 30 documentos. Se o assunto aparece em 140, ela escolhe pelo ranking e para. Ninguém mede o que ficou de fora. Só 29 documentos contêm literalmente "lei do ritmo" ou "princípio do ritmo"; os outros tratam do tema com outras palavras.
4. **Busca por sentido limitada.** Com 20 candidatos por sub-busca, a fusão do modo "Tudo" acerta cerca de 8 em 10 mesmo para quem vê 100 %, e bem menos para quem vê parte (KBC-120).
5. **Sem medida de completude.** O `agent-eval` mede se a resposta citou *um* dos documentos esperados ("hit"), não se cobriu *todos* os aspectos.

**Conclusão:** com o desenho atual, a completude depende da sorte da busca e do julgamento da IA no momento. Não dá para garanti-la aumentando passos: o problema está em **o mapa não existir no nível certo**.

## 2. O que existe de melhor (e é complementar ao kb)

| Abordagem | Ideia | O que resolve aqui |
|---|---|---|
| **Indexação por trecho com proposições** (Dense X Retrieval, Chen et al. 2023) | Cada trecho vira afirmações curtas e autocontidas ("O princípio do ritmo diz que tudo flui e reflui") | Os livros deixam de ser uma caixa-preta: cada ensinamento fica endereçável |
| **Contexto no trecho** (Contextual Retrieval, Anthropic 2024) | Antes de indexar, cada trecho ganha uma linha dizendo de onde vem e do que trata | Menos buscas que falham (o artigo mede de −35 % a −67 % de falhas) |
| **Árvore de assuntos e resumos** (RAPTOR, Sarthi et al. 2024; GraphRAG "community summaries", Microsoft 2024) | Agrupar trechos por assunto em níveis e escrever um resumo por grupo | Perguntas do tipo "tudo sobre X" respondidas a partir do grupo inteiro, não de uma busca |
| **Wiki de conhecimento mantida por IA** (o modo `wiki` do kb já prevê isso) | Uma página por assunto com a síntese, ligada às fontes | O "mapa mental" do assunto, legível também pelo estudante |
| **Verificação de citações** | Cada frase da resposta é conferida contra o trecho citado | Corretude: nada que o acervo não diga |
| **Conjunto de avaliação com gabarito** | Perguntas com os aspectos e trechos esperados, medidas a cada mudança | Prova de que está completo, e de que continua completo |

O kb já tem a estrutura certa: as páginas `wiki/concepts`, o `kb link` com o modelo de decisão e o `kb find` com candidatos por código e julgamento por modelo. **A proposta estende o kb, não o troca:** a classificação desce do documento para o trecho, e as páginas de conceito deixam de ser stubs e viram o mapa.

## 3. Proposta: o mapa do assunto é feito antes, e o Profundo responde a partir dele

O princípio: **a completude é garantida na indexação**, quando há tempo de ler tudo, e não na hora da pergunta, com 15 passos.

### Camada 1. Trechos com proposições (kb, no Mac, incremental)
- Cada documento é dividido em seções de 1 a 3 páginas, respeitando títulos e capítulos.
- Para cada seção, o kb grava:
  - uma linha de contexto;
  - as proposições (os ensinamentos afirmados);
  - os assuntos da árvore (camada 2);
  - as entidades;
  - quem afirma: Mestre Laércio ou outro autor (ADR 0015).
- Custo estimado: uma passagem por ≈ 32 milhões de tokens com um modelo barato, entre US$ 5 e 15 uma única vez. Depois, só o que mudar.

### Camada 2. Árvore de assuntos fina, com sinônimos (kb, revisada pelo dono)
- Os 39 conceitos viram a raiz. Abaixo deles, subassuntos saem do agrupamento das proposições, e a IA dá nome e sinônimos a cada grupo. Exemplo: Hermetismo → Sete Princípios → Ritmo, com os sinônimos "fluxo e refluxo", "pêndulo" e "lei da periodicidade".
- O dono revisa a árvore uma vez e corrige nomes e fusões. Novos documentos entram nos nós que já existem, e o que não couber vai para a fila de revisão do kb.

### Camada 3. Dossiê por assunto, o "mapa mental" (kb, gerado da varredura completa)
- Cada nó da árvore ganha uma página (a página de conceito do kb, agora preenchida) com:
  - os **aspectos** do assunto (por exemplo: definição; como se manifesta no corpo, na história e na vida espiritual; como neutralizá-lo, a "lei da neutralização"; relação com a polaridade);
  - para cada aspecto, **todos** os trechos que o tratam, com a fonte, o autor e uma marca dos trechos centrais;
  - onde os autores concordam e onde divergem.
- O dossiê é construído com **todas** as seções marcadas com o assunto, não por uma busca. Por isso ele é completo por construção. A IA que escreve o dossiê é conferida da mesma forma que as respostas (camada 5).

### Camada 4. O Profundo guiado pelo app
1. **Situar a pergunta:** o app, com uma chamada curta à IA e os sinônimos da árvore, acha os nós da árvore que a pergunta toca.
2. **Ler o mapa:** carrega os dossiês desses nós, ou seja, a lista garantida de aspectos e trechos.
3. **Completar fora do mapa:** busca por sentido (com o KBC-120) e busca pelos termos, para o que a árvore ainda não cobre ou que é novo.
4. **Responder por aspecto:** a IA recebe os trechos centrais de cada aspecto e escreve. O app confere se todo aspecto do dossiê foi tratado ou descartado com motivo ("não se aplica à pergunta"). Faltou algum? O app manda a IA tratar antes de entregar.
5. **Mostrar o mapa ao estudante:** no fim, "Esta resposta cobre os 6 aspectos que o acervo trata sobre a lei do ritmo", com os aspectos clicáveis. O estudante não precisa conhecer o acervo: o mapa mostra o assunto inteiro e o que foi coberto.

O custo por pergunta cai em vez de subir: o dossiê já fez a leitura pesada, e a IA lê os trechos centrais, não 140 documentos.

### Camada 5. Corretude conferida pelo app
- Cada frase com citação é conferida contra o trecho citado por uma chamada barata de verificação. Frase sem apoio é reescrita ou retirada, sem chegar ao leitor (segue a ADR 0004).
- A resposta separa o ensinamento do Mestre Laércio do que vem de outros autores (ADR 0015), como o dossiê já separa.

### Camada 6. Prova: o gabarito
- O dono e a IA montam juntos de 30 a 50 perguntas de estudo reais, cada uma com os aspectos esperados e os trechos que os sustentam. A IA propõe a partir do dossiê, e o dono confirma.
- O que se mede a cada mudança (no `agent-eval` estendido):
  - **cobertura de aspectos** (meta ≥ 95 %);
  - **precisão das citações** (meta ≥ 98 % das frases apoiadas no trecho);
  - **recall dos trechos centrais**.
- Sem esse gabarito, "completo" é uma opinião. Com ele, é um número que não pode cair.

## 4. O mapa sempre atualizado: ao inserir um documento (pedido do dono, 2026-11-16)

Um documento novo precisa entrar no mapa junto com todos os outros, e não só na busca. Hoje há dois caminhos de entrada, e os dois passam pelo Mac antes da produção (a API nunca escreve no vault, Q7):

| Entrada | Hoje | Com o mapa |
|---|---|---|
| Texto (livro, apostila, palestra transcrita fora do app) | `kb ingest` → `classify` → `link` → `index` no Mac → `sync-vault.sh` | o mesmo, mais `kb-map update` antes do sync, num comando só (`tools/kb-map add`) |
| Faixa de áudio publicada | o job `kb-publish` do transcritor (ADR 0035) escreve, classifica, liga, indexa e sincroniza | o mesmo job roda `kb-map update` para os documentos do lote antes do sync |

**O que `kb-map update` faz com um documento novo:**
1. Divide em seções e extrai as proposições e o autor (camada 1).
2. Põe cada seção nos nós da árvore que ela trata. Uma seção que não cabe em nenhum nó propõe um nó novo, e a proposta vai para a fila de revisão. Até a revisão, a seção fica no nó mais próximo, marcada "a revisar".
3. Refaz **só os dossiês dos nós tocados**: acrescenta os trechos novos aos aspectos e, se for o caso, cria um aspecto novo. O resto do mapa não muda.
4. Grava a versão do mapa e o que mudou (`map.log`), e o sync leva tudo para a produção.

**A garantia é verificada por código, não por confiança** (`kb-map check`, que roda antes de todo sync e nos testes):
- toda seção de todo documento está em pelo menos um nó, ou fica marcada "fora do mapa" com motivo (índice, sumário, ficha catalográfica);
- todo dossiê cita **exatamente** o conjunto de seções do seu nó: nem uma a menos, nem uma a mais;
- todo documento do acervo tem o mapa na versão do seu conteúdo atual.

Se a checagem falha, o sync não leva o mapa novo e o job aparece como falho no app. Um documento que entrou mas ainda não está no mapa ("pendente no mapa") é pesquisado pelo Profundo com a busca por termos e por sentido, e entra na cobertura da resposta. Nada some enquanto o mapa se atualiza.

## 5. Atualizar o acervo que já existe: localmente, com a assinatura

Os cerca de 3.000 documentos de hoje passam pelo mapa uma vez, no Mac, usando a assinatura do Claude ou do Codex em vez de pagar por token (as ADRs 0019 e 0020 já usam os dois CLIs). Depois tudo vai para a produção pelo `sync-vault.sh`.

- **Executor retomável** (`tools/kb-map backfill`): processa por lotes, grava o progresso a cada documento e, quando a assinatura bate no limite de uso, pausa e continua sozinho na janela seguinte. Pode levar dias; o custo é zero além do plano.
- **Modelo por tarefa:**
  - a extração das seções (o volume grande, cerca de 32 milhões de tokens) vai para o modelo mais rápido da assinatura;
  - a árvore e os dossiês (pouco volume, muita síntese) vão para o modelo mais forte.
  
  Se a assinatura não der conta do volume, a extração pode ir para o modelo barato que o kb já usa (DeepSeek V4 Flash), estimado em US$ 5 a 15.
- **Piloto antes de tudo:**
  - 50 documentos e o assunto "Sete Princípios";
  - medido no gabarito (item 2): quanto tempo e quanto da cota foram usados;
  - o dono confere o dossiê de um assunto que conhece bem.
  
  Só então vai o acervo inteiro.
- **Ordem da subida:** o mapa completo e a `kb-map check` verde no Mac, depois o sync para a produção, depois a API passa a usar o mapa. Durante o backfill, a produção segue como hoje.

## 6. Ordem sugerida (cada um um item do backlog)

| # | Item | Onde | Entrega visível |
|---|---|---|---|
| 1 | KBC-120 ampliado: o patch do QMD vale para todos no modo "Tudo" | app | Busca por sentido certa para quem vê tudo ou parte |
| 2 | KBC-138 Gabarito de estudo e medição de cobertura | app (`agent-eval`) | O número de hoje: quanto o Profundo cobre |
| 3 | KBC-139 Trechos com proposições e contexto | `tools/kb-map` (Mac) | Cada ensinamento dos livros endereçável |
| 4 | KBC-140 Árvore de assuntos com sinônimos e revisão do dono | `tools/kb-map` + app | Assuntos como "Ritmo" existem e têm sinônimos |
| 5 | KBC-141 Dossiê por assunto e a checagem de completude | `tools/kb-map` | As páginas de conceito preenchidas: o mapa mental |
| 6 | KBC-142 Mapa atualizado ao inserir: texto e faixa | `tools/kb-map` + transcritor | Documento novo entra no mapa sozinho |
| 7 | KBC-143 Backfill local do acervo com a assinatura e subida para a produção | Mac → produção | O Hermetismo inteiro mapeado |
| 8 | KBC-144 Profundo guiado pelo mapa, com cobertura por aspecto | app | A resposta completa, e o mapa mostrado ao estudante |
| 9 | KBC-145 Verificação de citações | app | Nenhuma frase sem apoio |
| 10 | KBC-146 Busca completa por termos na tela de Buscar | app | A lista de todo documento com os termos |

O KBC-138 vem antes do resto de propósito: mostra quanto falta hoje e prova o ganho de cada passo seguinte. O dossiê também alimenta a Página do assunto da v2 (KBC-137).

## 7. Decisões (assumidas pelo padrão recomendado; o dono pode mudar)
- **D1:** o "completo" é garantido pelo mapa feito na indexação e verificado por código (`kb-map check`).
- **D2:** o dono revisa a árvore de assuntos uma vez por acervo; depois, só a fila de revisão.
- **D3:** o código do kb não está nesta máquina, então o mapa é uma ferramenta deste repositório (`tools/kb-map`, Python com uv, como o transcritor). Ela lê o que o kb escreve e grava no vault, só no Mac. Se o dono quiser, a ferramenta vira parte do kb depois.
- **D4:** a meta de cobertura do gabarito: 95 % dos aspectos.
- **D5:** o backfill roda na assinatura (Claude ou Codex) no Mac. O modelo pago só entra se a assinatura não der conta, e com o "sim" do dono (custo).
