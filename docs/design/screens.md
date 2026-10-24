# Telas e fluxos — kb-chat (esqueleto + release 1)

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

---

## T4. Responder com IA

**Objetivo:** obter uma síntese da pergunta a partir do acervo, sabendo quanto custa e de onde veio. **Sucesso:** toda afirmação tem uma citação clicável, e o custo aparece antes e depois.

### Fluxo
1. Abaixo dos cartões: botão secundário **"Responder com IA · ~US$ 0,01"** (custo estimado visível no próprio botão, SL-24). Nunca dispara sozinho.
2. Clique → estado "Lendo as fontes…" com etapas ("Escolhendo documentos (kb find)…", "Escrevendo resposta…") e "Parar".
3. A resposta chega em streaming como uma mensagem do sistema. Citações [1], [2] abrem o painel no documento; abaixo, "Fontes" lista os documentos usados e "Custo: US$ 0,008".
4. A resposta segue os filtros ativos. O cabeçalho da resposta diz quais ("Considerando: Cabala · Central").

### Regras de conteúdo
- A IA responde **só** a partir das fontes recuperadas. Sem base, diz "O acervo não traz informação suficiente sobre isso" e sugere outra busca. Isso é honestidade, não falha.
- Rodapé fixo: "Resposta gerada por IA a partir do acervo; confira nas fontes."

### Estados
| Estado | Mostra | Ação |
|---|---|---|
| Sem chave da OpenRouter | O botão aparece desabilitado com explicação: "Configure OPENROUTER_API_KEY no servidor para usar respostas com IA." (SL-20) | — |
| Saldo insuficiente (HTTP 402) | "Os créditos da OpenRouter acabaram. Adicione em openrouter.ai/settings/credits." (tom sério, DS-19) | Link |
| Teto diário atingido | "Limite de gasto de hoje atingido (US$ 1,00). Volta amanhã ou ajuste em Configurações." | — |
| Erro do modelo ou timeout | "Não consegui gerar a resposta agora." + "Tentar de novo" (os resultados grátis continuam na tela) | Tentar de novo |
| Interrompida | Texto parcial + "(interrompida)" + custo parcial | "Continuar" não existe na R1; "Tentar de novo" |

---

## T5. Lateral: sessão, acervo e tema

- **+ Nova conversa** e o histórico **da sessão**, guardado no navegador e rotulado "neste navegador" (o histórico persistente fica fora da R1).
- **Acervo ▾**: lista de `kb topic list` com a contagem de documentos. Trocar de acervo inicia uma conversa nova (aviso inline, sem modal).
- **Tema**: "Automático (claro/escuro)" · "Claro" · "Escuro" · "Esotérico", lembrado no navegador.
- **Gasto com IA hoje: US$ 0,03 de US$ 1,00** (UP-02).

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
