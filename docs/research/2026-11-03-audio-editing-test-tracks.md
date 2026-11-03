# Teste prático de faixas de pergunta e resposta e títulos, em pt-BR (KBC-063, FR-5)

Data: 2026-11-03. Pedido: `docs/backlog/KBC-063-research-audio-editing-methods.md` (FR-5, AC-5) e o plano das frentes 3, 4 e 5 e da seção 10 de [`2026-11-03-audio-editing-methods.md`](2026-11-03-audio-editing-methods.md). Continua o [teste de reconhecimento de orador](2026-11-03-audio-editing-test-speakers.md), de onde vêm as vozes.

Convenções: **[verificado]** = medido por nós neste Mac nesta data; **[inferido]** = conclusão nossa sem medição (aqui, em especial, a leitura que fizemos das propostas antes da nota do dono).

**Autorização** (dono, 2026-11-03): "pode mandar o texto para a API" — só o **texto** da transcrição das duas gravações de teste (entrevista com M. Zé Luiz e Sergio Melo; ADM MESTRE MONTEIRO). Nenhum áudio saiu do Mac; as gravações de referência não foram enviadas. No OpenRouter pedimos só provedores que não guardam nem treinam com os dados (`provider.data_collection = "deny"`).

## 1. Resumo

- **Validade** [verificado]: DeepSeek V4 Flash e Qwen3 235B deram JSON válido nas 4 janelas, de primeira. O modelo local (Qwen3-30B-A3B, 4 bits) acertou 3 de 4 janelas; na 2ª janela da entrevista estourou o limite de 3.000 tokens de saída duas vezes (faixas demais em JSON indentado) e esse trecho (06:05–12:01) ficou sem proposta.
- **Custo** [verificado]: US$ 0,0048 por hora de áudio (DeepSeek V4 Flash) e US$ 0,0060/h (Qwen3 235B); local US$ 0. **Gasto total do teste: US$ 0,0041** (saldo do OpenRouter antes 6,118888, depois 6,114768), longe do teto de US$ 0,50.
- **Tempo** [verificado]: DeepSeek 37 s por hora de áudio; Qwen3 235B 225 s/h; local **648 s/h (≈ 11 min/h)**, medido com o Mac muito carregado (média de carga 35–46) — bem acima da estimativa de 1–1,5 min/h.
- **Forma das propostas** [inferido; falta a nota do dono]: DeepSeek separou a entrevista exatamente nas 4 perguntas que a diarização mostra; Qwen3 235B juntou a entrevista inteira numa faixa só; o local partiu o ADM em 14 faixas, várias de 8–20 s começando no meio da frase. A decisão espera a nota cega do dono (seção 6).
- **Sabiazinho-4 (Maritaca)**: não testado — não há chave da Maritaca.

## 2. Montagem [verificado]

- **Entrada**: transcrição mlx-whisper turbo (pt) das 2 gravações de teste, em segmentos numerados `[id] mm:ss Voz: texto`; a voz de cada segmento é o grupo do Senko com maior sobreposição, com nome só onde a receita Senko + ECAPA reconheceu o orador (T = 0,4, margem 0,1). Resultado: entrevista = "Mestre José Luiz" (230 segmentos) e "Voz 1" (11, o entrevistador); ADM = "Voz 1" (voz principal) e "Voz 2" (quem pede a leitura). No ADM a voz principal ficou sem nome porque nessa receita a margem para o outro perfil foi 0,083 (< 0,1); na receita só-ECAPA ela seria "Mestre Monteiro".
- **Contexto fixo**: nome do acervo ("UDV") e a lista de vozes; **o título da gravação não é passado**. **Contexto dinâmico**: as faixas da janela anterior (ids, tipo, título); a primeira faixa de uma janela pode ser marcada como continuação da última faixa anterior, e o código junta as duas.
- **Janelas de 6 min** sem sobreposição (2 por gravação). O plano previa ~20 min com 3 min de sobreposição; como as gravações têm 11–12 min, uma janela de 20 min não exercitaria o contexto da janela anterior.
- **Prompt** (pt-BR, igual para todos): pergunta + resposta inteira = uma faixa; pergunta de continuação da mesma pessoa fica na mesma faixa; o resto é "exposicao", dividida só quando o assunto muda; cobertura de todos os ids da janela, em ordem, sem buraco nem sobreposição; mínimo 5 s; só ids, nunca horários; rótulos de voz exatamente como vieram; título pt-BR até 60 caracteres, específico, sem inventar, sem copiar erros da transcrição, sem "corrigir" termos do acervo (União do Vegetal, UDV, vegetal, Mestre Gabriel, mestre, conselheiro, discípulo, sessão, preparo, estrela de mestre). Saída: `{"faixas": [{primeiro_id, ultimo_id, tipo, quem_pergunta, quem_responde, titulo, continua_faixa_anterior}]}`.
- **Validação por janela**: JSON lido; ids existem na janela; faixas em ordem, contíguas, cobrindo a janela inteira; cada faixa ≥ 5 s (a continuação é checada depois de juntar); tipo e título presentes. Falhou → **uma** nova tentativa com a lista de erros; falhou de novo → a janela fica sem proposta.
- Parâmetros: temperatura 0,2; até 3.000 tokens de saída; na API `response_format = json_object` e custo real pelo campo `usage.cost`; DeepSeek com raciocínio desligado.

| Abordagem | Modelo | Onde | Versões |
| --- | --- | --- | --- |
| A — local | `mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit` (17,2 GB; download único de 25,5 min) | Mac (M4 Max, 64 GB) | mlx-lm 0.32.2, mlx 0.32.4 |
| B1 — API | `qwen/qwen3-235b-a22b-2507` (US$ 0,09 / 0,55 por milhão) | OpenRouter (provedores DeepInfra e Parasail) | — |
| B2 — API | `deepseek/deepseek-v4-flash` (US$ 0,091 / 0,182 por milhão) | OpenRouter (provedores Crusoe e Relace) | — |
| C — Sabiazinho-4 | — | — | **não testado**: sem chave da Maritaca |

## 3. Validade [verificado]

| Abordagem | Janelas válidas de primeira | Válidas após 1 nova tentativa | Faixas (entrevista / ADM) | Erros |
| --- | --- | --- | --- | --- |
| A — local Qwen3-30B-A3B | 3 de 4 | 3 de 4 | 7 (só até 06:04) / 14 | entrevista, janela 2: saída cortada em 3.000 tokens nas 2 tentativas (JSON incompleto). Rodada fora da medição, a mesma janela completou com 28 faixas de 2–10 segmentos cada — a causa é partir demais + JSON indentado, não JSON malformado |
| B1 — Qwen3 235B | 4 de 4 | 4 de 4 | 1 / 4 | nenhum |
| B2 — DeepSeek V4 Flash | 4 de 4 | 4 de 4 | 6 / 4 | nenhum |

## 4. Custo e tempo [verificado]

Áudio somado das 2 gravações: 0,381 h (22:51).

| Abordagem | Tokens entrada / saída | US$ (2 gravações) | US$ por hora de áudio | Tempo de parede | Tempo por hora de áudio |
| --- | --- | --- | --- | --- | --- |
| A — local | 26.424 / 7.947 (inclui as 2 tentativas cortadas) | 0 | 0 | 246,9 s (+ 3–6 s para carregar o modelo) | **648 s/h** |
| B1 — Qwen3 235B | 18.299 / 561 | 0,002304 | **0,0060** | 85,7 s | 225 s/h |
| B2 — DeepSeek V4 Flash | 15.928 / 1.008 | 0,001817 | **0,0048** | 14,0 s | **37 s/h** |

- Saldo OpenRouter (créditos − uso): antes **US$ 6,118888**, depois **US$ 6,114768** → gasto **US$ 0,004120**, igual à soma do campo `usage.cost` das chamadas (0,004121).
- O custo por hora ficou ~2× a conta do relatório de métodos (0,0024–0,0031/h) porque o prompt fixo (regras) se repete a cada janela de 6 min; continua centenas de vezes abaixo do teto de US$ 0,05/h [verificado + inferido].
- Local: geração de 17–60 tokens/s, abaixo dos ~90–107 tokens/s relatados por terceiros; o Mac estava com média de carga 35–46 (outros trabalhos rodando), então o tempo é pessimista [inferido]. Mesmo dividido por 3, fica acima de 1,5 min/h.

## 5. O que vimos nas propostas (antes da nota do dono) [inferido]

Referência usada: as trocas de voz da diarização. Na entrevista o entrevistador (Voz 1) fala em 00:00, 03:57, 04:37, 05:38 e 06:18–06:33; no ADM a Voz 2 fala em 03:44 ("Eu quero que o senhor leia este trecho aqui também"), 06:18 ("eu quero que o senhor diga… sobre o desencarnamento do mestre") e 07:39 ("também o senhor pode falar em outros assuntos").

- **Entrevista**: uma proposta começa as faixas exatamente nessas 4 perguntas e põe a fala de 06:18–06:33 do entrevistador como introdução de 15 s; outra junta tudo numa faixa de 12 min; a terceira parte o relato da primeira resposta em 4 faixas e não cobre a segunda metade.
- **ADM**: as três acham a pergunta de 06:18; só uma trata o pedido de leitura de 03:44 como começo de faixa; nenhuma faz faixa nova em 07:39 como pergunta (todas tratam como começo de exposição). Uma delas tem 14 faixas, várias começando em "e,", "bem,", "no momento,".
- Os títulos citam fatos do texto (olaria, estatuto, OASCA, Porto Velho, sangue derramado); nenhum inventou nome. Um título usa "no UDV" (o acervo diz "na UDV").

## 6. Para o dono: propostas às cegas

Como avaliar: as gravações estão no acervo ("Entrevista com M. Zé Luiz, Sergio Melo" e "ADM MESTRE MONTEIRO"). Para cada proposta, dê **nota 1–5 a cada título** (5 = eu usaria assim) e marque **"Limite errado?"** quando a faixa começa ou termina no lugar errado (diga onde deveria). As três propostas usam a mesma transcrição e as mesmas vozes; a ordem é sorteada e a chave fica no fim do arquivo — **não abra a chave antes de dar as notas**.

### Entrevista com M. Zé Luiz, Sergio Melo (12:04)

#### Proposta 1 (1 faixas)

| # | Início–fim | Título | Tipo | Pergunta → resposta | Primeiras palavras | Nota do título (1–5) | Limite errado? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 00:00–12:01 | Origem no UDV e primeira sessão com Mestre Gabriel | Pergunta e resposta | Voz 1 → Mestre José Luiz | "Mestre José Luiz, o senhor está lembrado das circunstâncias que…" | | |

#### Proposta 2 (6 faixas)

| # | Início–fim | Título | Tipo | Pergunta → resposta | Primeiras palavras | Nota do título (1–5) | Limite errado? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 00:00–03:56 | Como Mestre José Luiz conheceu a União do Vegetal | Pergunta e resposta | Voz 1 → Mestre José Luiz | "Mestre José Luiz, o senhor está lembrado das circunstâncias que…" | | |
| 2 | 03:57–04:36 | Quem estava no preparo do vegetal na olaria | Pergunta e resposta | Voz 1 → Mestre José Luiz | "Só tem na lembrança, quem seriam essas pessoas que estavam…" | | |
| 3 | 04:37–05:37 | O que prendeu Mestre José Luiz na União do Vegetal | Pergunta e resposta | Voz 1 → Mestre José Luiz | "A contar desta primeira sessão que o senhor participou, e…" | | |
| 4 | 05:38–06:17 | Mensagem aos discípulos novos da União do Vegetal | Pergunta e resposta | Voz 1 → Mestre José Luiz | "Hoje em dia o senhor é um mestre na União…" | | |
| 5 | 06:18–06:33 | Participação de Mestre José Luiz na instituição da União do Vegetal | Exposição | fala: Voz 1 | "O mestre José Luiz de Oliveira teve uma participação destacada…" | | |
| 6 | 06:33–12:01 | Elaboração do estatuto e organização da União do Vegetal | Pergunta e resposta | Voz 1 → Mestre José Luiz | "Quando eu cheguei na União do Vegetal, como eu já…" | | |

#### Proposta 3 (7 faixas)

Sem proposta válida de 06:05–12:01 (a resposta para esse trecho veio inválida duas vezes).

| # | Início–fim | Título | Tipo | Pergunta → resposta | Primeiras palavras | Nota do título (1–5) | Limite errado? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 00:00–01:08 | Chegada de Mestre José Luiz à UDV | Pergunta e resposta | Voz 1 → Mestre José Luiz | "Mestre José Luiz, o senhor está lembrado das circunstâncias que…" | | |
| 2 | 01:10–02:29 | Primeiro contato com o chá e a sessão | Exposição | fala: Mestre José Luiz | "E ele me mandou que eu encostasse o carro e…" | | |
| 3 | 02:29–03:13 | Advertência sobre a hora da sessão | Exposição | fala: Mestre José Luiz | "Ele apresentava uma força e tudo mais. E eu não…" | | |
| 4 | 03:13–03:56 | Primeira sessão na casa do mestre Gabriel | Exposição | fala: Mestre José Luiz | "E no dia seguinte eu fui, bebi o retalto. Participei…" | | |
| 5 | 03:57–04:36 | Pessoas presentes no preparo inicial | Pergunta e resposta | Voz 1 → Mestre José Luiz | "Só tem na lembrança, quem seriam essas pessoas que estavam…" | | |
| 6 | 04:37–05:29 | Motivos para permanecer na UDV | Pergunta e resposta | Voz 1 → Mestre José Luiz | "A contar desta primeira sessão que o senhor participou, e…" | | |
| 7 | 05:30–06:04 | Mensagem para discípulos novos | Exposição | fala: Mestre José Luiz | "doutrinando e procurando de uma certa maneira. Então aquele foi…" | | |

### ADM MESTRE MONTEIRO (10:50)

#### Proposta 1 (4 faixas)

| # | Início–fim | Título | Tipo | Pergunta → resposta | Primeiras palavras | Nota do título (1–5) | Limite errado? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 00:00–06:18 | Histórico na UDV e carta do mestre Gabriel | Exposição | fala: Voz 1 | "Eu sou de naturalidade amazonense, lugar denominado Larginho, o Maitá…" | | |
| 2 | 06:18–06:54 | Sentimentos após o desencarnamento do mestre | Pergunta e resposta | Voz 2 → Voz 1 | "Agora, eu quero que o senhor diga, outra coisa também…" | | |
| 3 | 06:56–07:38 | Frase do mestre sobre o sangue derramado | Exposição | fala: Voz 1 | "Durante a permanência do mestre, na terra, ouvi, durante o…" | | |
| 4 | 07:39–10:49 | Chegada do mestre e transição de liderança | Exposição | fala: Voz 1 | "também o senhor pode, falar em outros assuntos, né, é…" | | |

#### Proposta 2 (4 faixas)

| # | Início–fim | Título | Tipo | Pergunta → resposta | Primeiras palavras | Nota do título (1–5) | Limite errado? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 00:00–03:42 | Relato de ingresso na UDV e carta do Mestre Gabriel | Exposição | fala: Voz 1 | "Eu sou de naturalidade amazonense, lugar denominado Larginho, o Maitá…" | | |
| 2 | 03:44–06:18 | Leitura de carta do Mestre Gabriel e continuação do relato | Pergunta e resposta | Voz 2 → Voz 1 | "Eu quero que o senhor leia este trecho aqui também…" | | |
| 3 | 06:18–07:38 | Sentimentos sobre o desencarnamento do Mestre Gabriel | Pergunta e resposta | Voz 2 → Voz 1 | "Agora, eu quero que o senhor diga, outra coisa também…" | | |
| 4 | 07:39–10:49 | Chegada do Mestre, última sessão de festa e sucessão | Exposição | fala: Voz 1 | "também o senhor pode, falar em outros assuntos, né, é…" | | |

#### Proposta 3 (14 faixas)

| # | Início–fim | Título | Tipo | Pergunta → resposta | Primeiras palavras | Nota do título (1–5) | Limite errado? |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 00:00–06:18 | História de chegada na UDV e atuação como representante | Exposição | fala: Voz 1 | "Eu sou de naturalidade amazonense, lugar denominado Larginho, o Maitá…" | | |
| 2 | 06:18–06:26 | Sensação diante do desencarnamento do mestre | Pergunta e resposta | Voz 2 → Voz 1 | "Agora, eu quero que o senhor diga, outra coisa também…" | | |
| 3 | 06:27–06:54 | Dificuldades após o desencarnamento do mestre | Exposição | fala: Voz 1 | "Isso foi um dia muito difícil, para nós, aqui na…" | | |
| 4 | 06:56–07:32 | Frase do mestre Gabriel sobre o sangue derramado | Exposição | fala: Voz 1 | "Durante a permanência do mestre, na terra, ouvi, durante o…" | | |
| 5 | 07:32–07:44 | Continuidade da caminhada na União do Vegetal | Exposição | fala: Voz 1 | "na União do Vegetal, é um caminho de luz, onde…" | | |
| 6 | 07:45–08:05 | Chegada do mestre em Porto Velho e recepção | Exposição | fala: Voz 1 | "bem, no dia, da chegada do mestre, fomos esperados, no…" | | |
| 7 | 08:05–08:29 | Última sessão de festa dirigida pelo mestre em 1970 | Exposição | fala: Voz 1 | "e que jamais, há de ser esquecida, neste dia, houve…" | | |
| 8 | 08:30–08:44 | Ordem para dirigir a sessão de 1971 | Exposição | fala: Voz 1 | "já não mais, dirigiu, a sessão, que é, de costume…" | | |
| 9 | 08:44–09:00 | Conteúdo da sessão de 1971 sobre a OASCA | Exposição | fala: Voz 1 | "me ordenou, que eu dirigisse, essa sessão, e contasse, a…" | | |
| 10 | 09:01–09:28 | Preparação para a representação geral após o desencarnamento | Exposição | fala: Voz 1 | "a história da OASCA, para que, todos ouvissem, e naturalmente…" | | |
| 11 | 09:29–09:37 | Momento do desencarnamento do mestre | Exposição | fala: Voz 1 | "e sim, num convívio espiritual, que permanece, quando, logo, ele…" | | |
| 12 | 09:38–09:59 | Dificuldades de comando após a ausência do mestre | Exposição | fala: Voz 1 | "foi um momento difícil, porque, não tinha, uma pessoa, no…" | | |
| 13 | 09:59–10:06 | Mudança de rumo com a nomeação do representante geral | Exposição | fala: Voz 1 | "no momento, em que, se colocou, um representante geral, as…" | | |
| 14 | 10:06–10:49 | Superar dificuldades com a boa vontade dos irmãos | Exposição | fala: Voz 1 | "e, se tornou mais fácil, a caminhada, muito embora, ainda…" | | |

## 7. Limites

- **Sem gabarito do dono** (perguntas e respostas marcadas à mão): não há precisão, revocação nem F1 dos limites ainda; a nota cega da seção 6 é o primeiro julgamento.
- **Gravações curtas** (11–12 min), 2 janelas cada; o efeito do contexto da janela anterior em palestras de 1–2 h não foi medido.
- **Uma rodada por abordagem**, temperatura 0,2: a variação entre rodadas não foi medida (a rodada extra do local, fora da medição, mudou o resultado).
- **Transcrição com erros** ("União do Rental", "retalto"); o prompt pede para não copiá-los, mas a qualidade dos títulos depende dela.
- **Vozes**: no ADM a voz principal entrou como "Voz 1" (não reconhecida nesta receita); a entrevista só tem perguntas onde a diarização separou o entrevistador.
- **Local medido com o Mac carregado**: o tempo do local é um teto, não o típico.

## 8. O que muda nos itens (a confirmar com a nota do dono)

- **KBC-067 (faixas)**: **DeepSeek V4 Flash** passa a ser a primeira opção na API — válido de primeira, o mais barato (US$ 0,005/h) e o mais rápido (37 s/h), e a forma mais próxima das trocas de voz [verificado + inferido]. Qwen3 235B fica como reserva só depois da nota: juntou a entrevista inteira. Isso inverte a ordem do relatório de métodos (que punha o Qwen3 235B primeiro pelo português); a nota do dono decide.
- **Modelo local (ADR 0029, decisão 3)**: o Qwen3-30B-A3B **ainda não serve de padrão** — 1 janela inválida em 4, faixas picadas e ~11 min por hora de áudio. Antes de outra rodada: JSON compacto (sem indentação) e limite de saída proporcional à janela, mínimo de ~30 s por faixa de exposição no prompt e candidatos de corte vindos das trocas de voz.
- **Validação + 1 nova tentativa** (KBC-067 FR-2) funcionou como planejado: barrou a saída cortada e nada inválido passou; vale manter, guardando a resposta crua para diagnóstico.
- **Sabiazinho-4**: segue sem medir até haver chave da Maritaca.

## 9. Scripts e dados

Em [`scripts/`](scripts/) (sem áudio, transcrição ou saída dos modelos no repositório; só as primeiras palavras de cada faixa aparecem acima):

| Script | Faz |
| --- | --- |
| `build_segments.py` | transcrição + grupos do Senko + reconhecimento → segmentos numerados com voz |
| `propose_tracks.py` | janelas, prompt, chamada local (mlx-lm) ou OpenRouter, validação, 1 nova tentativa, custo e tempo |
| `blind_proposals.py` | propostas lado a lado com ordem sorteada (semente 20261103) e a chave separada |
| `openrouter_balance.py` | saldo do OpenRouter (créditos − uso); a chave vem do ambiente e só vai no cabeçalho |

Reproduzir (de `~/dev/personal/kb-chat-research`, `S=<worktree>/docs/research/scripts`): `.venv/bin/python $S/build_segments.py out <n>`; `.venv/bin/python $S/propose_tracks.py out <n> --engine local` e `--engine openrouter --model <id>`; `.venv/bin/python $S/blind_proposals.py out 20261103 "<n>:<título>" … --tags local,qwen3-235b-a22b-2507,deepseek-v4-flash`.

## 10. Chave das propostas (abrir só depois de dar as notas)

<details>
<summary>Mostrar qual abordagem fez cada proposta</summary>

| Proposta | Abordagem |
| --- | --- |
| Proposta 1 | B1 — Qwen3 235B (`qwen/qwen3-235b-a22b-2507`, OpenRouter) |
| Proposta 2 | B2 — DeepSeek V4 Flash (`deepseek/deepseek-v4-flash`, OpenRouter) |
| Proposta 3 | A — local, Qwen3-30B-A3B-Instruct-2507 4 bits (mlx-lm, Mac) |

</details>
