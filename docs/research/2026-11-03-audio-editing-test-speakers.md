# Teste prático de reconhecimento de orador pela voz, em pt-BR (KBC-063, FR-5)

Data: 2026-11-03. Pedido: `docs/backlog/KBC-063-research-audio-editing-methods.md` (FR-5, BR-5) e o plano da seção 10 de [`2026-11-03-audio-editing-methods.md`](2026-11-03-audio-editing-methods.md). Este relatório cobre a parte **reconhecimento do orador** e a **diarização sem gabarito**; DER e faixas de pergunta e resposta ficam para quando houver a marcação do dono (ver "Limites").

Convenções: **[verificado]** = medido por nós neste Mac nesta data; **[inferido]** = conclusão nossa sem medição. Tudo rodou no Mac do dono; nenhum áudio, transcrição ou vetor saiu da máquina (BR-5). Rede usada só para baixar pacotes e os pesos públicos do ECAPA e do Senko. Custo: US$ 0.

## 1. Resumo

- **O orador foi reconhecido nos dois pares** com a receita de base (ECAPA, limiar de agrupamento 0,3, limiar de reconhecimento **T = 0,4 com margem ≥ 0,1**): na entrevista, a voz dominante foi dada como Mestre José Luiz (0,477 contra 0,155) e a voz do entrevistador ficou "não sei" (0,128 / 0,170); na gravação ADM, a voz dominante foi dada como Mestre Monteiro (0,567 contra 0,405). Zero falso positivo nos 3 casos [verificado].
- **A margem é que salva**: a voz do ADM ficou a 0,405–0,486 do perfil do José Luiz, ou seja, acima de T = 0,4 e perto do acerto real do José Luiz (0,477). Sem a regra da margem haveria falso positivo; com T = 0,5 o José Luiz deixa de ser reconhecido [verificado]. Com 2 oradores **não dá para fixar T com segurança**; é um ponto de partida, não um limiar calibrado.
- **Senko** (MIT) separa vozes muito bem e muito rápido (2–7 s de máquina por hora de áudio), mas **os vetores CAM++ dele não servem para reconhecer** do jeito que vêm: tudo fica entre 0,56 e 0,83 com os dois perfis, e o entrevistador seria dado como José Luiz (falso positivo) [verificado]. A melhor separação foi a do Senko; o melhor reconhecimento foi com ECAPA.
- **pyannote `community-1` não foi testado**: o modelo é de acesso controlado no Hugging Face e não há token; fica pendente (seção 8).

## 2. Material

Pares confirmados pelo dono (2026-11-03). O nome sai **só** do título da gravação de referência; na de teste o título não é usado.

| Papel | Orador (do título) | Arquivo do acervo (só leitura) | Título | Duração |
| --- | --- | --- | --- | --- |
| Referência | Mestre José Luiz | `8ef7ed49-….m4a` | "07- ANIV MESTRE JOSÉ LUIZ" (palestra) | 28:38 |
| Teste | — | `2d3a3fdf-….m4a` | "Entrevista com M. Zé Luiz, Sergio Melo" (duas vozes) | 12:04 |
| Referência | Mestre Monteiro | `18469445-….m4a` | "Aniversario da UDV 1975 - M. Monteiro" | 6:40 |
| Teste | — | `c78d227f-….m4a` | "ADM MESTRE MONTEIRO" | 10:50 |

Cada perfil é controle negativo do outro orador. Os arquivos foram convertidos para WAV 16 kHz mono em `~/dev/personal/kb-chat-research/audio/` (fora dos repositórios).

## 3. Montagem, ferramentas e versões [verificado]

Mac: Apple M4 Max, 64 GB, macOS 27.2. Ambiente isolado: `~/dev/personal/kb-chat-research/.venv` (Python 3.12.16).

| Peça | Versão | Papel |
| --- | --- | --- |
| ffmpeg | 9.0.2 | m4a → WAV 16 kHz mono |
| silero-vad | 6.2.3 | detecção de fala (base) |
| SpeechBrain + `speechbrain/spkrec-ecapa-voxceleb` | 1.1.2 | vetor de voz ECAPA (192 dim.) |
| torch / torchaudio | 2.15.0 / 2.11.1 | ECAPA no MPS (GPU do Mac) |
| scikit-learn | 1.9.1 | agrupamento aglomerativo |
| Senko (github narcotic-sh/senko, commit `1bcb090`) | 0.1.0 | diarização: VAD/segmentação pyannote 3.0 + CAM++ em CoreML |
| coremltools | 9.0 | dependência do Senko |
| mlx-whisper + `mlx-community/whisper-large-v3-turbo` | 0.4.3 (mlx 0.32.4) | transcrição pt com tempo por palavra |

Receita de base (ECAPA), conforme o plano:

1. Silero VAD (fala ≥ 0,3 s, silêncio ≥ 0,3 s).
2. Janelas de 1,5 s com passo de 0,75 s sobre a fala; vetor ECAPA de cada janela, normalizado (L2).
3. Agrupamento aglomerativo, ligação média, cosseno, **limiar de semelhança 0,3** (distância 0,7). Varremos 0,2 / 0,25 / 0,3 / 0,35 / 0,4.
4. Grupos com menos de 10 s de fala são absorvidos pelo grupo grande mais parecido (sem isso, janelas de 1,5 s viram dezenas de grupos: 167 na palestra do José Luiz a 0,3).
5. Janelas vizinhas do mesmo grupo são unidas (folga ≤ 0,5 s).

Perfil = média dos vetores normalizados das janelas do grupo dominante (mais tempo de fala) da gravação de referência. Reconhecimento: cosseno entre o centróide de cada grupo do teste e **os dois perfis**; decisão "é o <nome>" se semelhança ≥ T **e** margem para o outro perfil ≥ 0,1 **e** o grupo tem ≥ 10 s de fala; senão "não sei".

Receitas comparadas: **ecapa** (acima); **senko** (grupos e centróides CAM++ do próprio Senko); **senko+ecapa** (grupos do Senko, vetores ECAPA das janelas que caem dentro de cada grupo).

Observação: ECAPA na CPU levou 156 s para 114 janelas; no MPS, 2 s, com vetores idênticos (cosseno mínimo 0,9999999 entre CPU e MPS) [verificado]. Usar MPS.

## 4. Diarização: grupos e tempo de fala [verificado]

Sem gabarito do dono não há DER; o que se mede aqui é quantas vozes cada método vê e quanto cada uma fala.

| Gravação | Fala (Silero) | ECAPA, limiar 0,3 (grupos brutos → após absorver < 10 s) | Senko |
| --- | --- | --- | --- |
| Palestra José Luiz (ref.) | 1.025 s | 167 → 16; dominante C0 = 124 s (minutos 0–17) | 3: 1.169 / 295 / 58 s |
| Entrevista (teste) | 659 s | 15 → 2: C0 = 537 s, C1 = 45 s | 3: 605 / 57 / 44 s |
| Aniversário 1975 Monteiro (ref.) | 124 s | 9 → 1: 81 s | 1: 234 s |
| ADM Monteiro (teste) | 467 s | 19 → 1: 335 s (a 0,35: 307 + 27 s) | 2: 630 / 13 s |

Leitura com a transcrição (seção 7):

- **Entrevista**: ECAPA e Senko acham as duas vozes. O grupo pequeno (C1 / SPEAKER_03) é o entrevistador ("Mestre José Luiz, o senhor está lembrado…"); o grande é quem responde. O Senko partiu a voz de quem responde em dois grupos (SPEAKER_01 e SPEAKER_02, semelhança ECAPA 0,94 entre eles).
- **Palestra do José Luiz**: gravação ruim — o Whisper alucina em vários trechos (palavras soltas, caracteres em chinês, "elected"). Por volta de 21:00 entra outra pessoa, que faz uma homenagem ao José Luiz ("estou feliz, com a presença do meu pai") — é o SPEAKER_02 do Senko (minutos 19–26). O ECAPA fragmenta muito essa gravação (várias famílias de grupos parecidos entre si, 0,6–0,8), sinal de canal ruim e variável; o grupo dominante C0 fica nos minutos 0–17, isto é, na fala do José Luiz [inferido da transcrição; confirmar ouvindo].
- **Monteiro 1975**: uma voz só, fala pausada (só 124 s de fala detectada em 6:40).
- **ADM**: uma voz principal que lê um texto na primeira pessoa ("Eu sou de naturalidade amazonense…") e uma segunda voz curta (Senko SPEAKER_02, 13 s: "Eu quero que o senhor leia este trecho aqui também"). O ECAPA a 0,3 não separou essa segunda voz (curta demais).

Escolha do limiar de agrupamento ECAPA: a 0,2 a entrevista vira uma voz só (perde o entrevistador); a 0,35 o ADM ganha um segundo grupo que é a mesma voz partida; **0,25–0,3** é a faixa que separa a entrevista sem partir o ADM [verificado].

## 5. Matriz de semelhança e reconhecimento [verificado]

Perfis — ecapa: José Luiz = C0 da palestra (124 s), Monteiro = C0 de 1975 (81 s); semelhança entre os dois perfis **0,079**. senko e senko+ecapa: SPEAKER_01 de cada referência (1.169 s e 234 s); entre perfis 0,686 (CAM++) e 0,190 (ECAPA).

| Receita | Gravação de teste | Grupo | Fala (s) | Quem é (pela transcrição) | Sim. José Luiz | Sim. Monteiro |
| --- | --- | --- | --- | --- | --- | --- |
| ecapa | Entrevista | C0 | 537 | quem responde | **0,477** | 0,155 |
| ecapa | Entrevista | C1 | 45 | entrevistador | 0,128 | 0,170 |
| ecapa | ADM | C0 | 335 | voz principal | 0,405 | **0,567** |
| senko+ecapa | Entrevista | SPEAKER_01 | 605 | quem responde | **0,524** | 0,152 |
| senko+ecapa | Entrevista | SPEAKER_02 | 57 | quem responde (2º grupo) | **0,536** | 0,188 |
| senko+ecapa | Entrevista | SPEAKER_03 | 44 | entrevistador | 0,177 | 0,172 |
| senko+ecapa | ADM | SPEAKER_01 | 630 | voz principal | 0,486 | **0,569** |
| senko+ecapa | ADM | SPEAKER_02 | 13 | 2ª voz ("leia este trecho") | 0,395 | 0,244 |
| senko (CAM++) | Entrevista | SPEAKER_01 | 605 | quem responde | 0,809 | 0,600 |
| senko (CAM++) | Entrevista | SPEAKER_02 | 57 | quem responde (2º grupo) | 0,826 | 0,661 |
| senko (CAM++) | Entrevista | SPEAKER_03 | 44 | entrevistador | 0,679 | 0,564 |
| senko (CAM++) | ADM | SPEAKER_01 | 630 | voz principal | 0,810 | 0,782 |
| senko (CAM++) | ADM | SPEAKER_02 | 13 | 2ª voz | 0,773 | 0,645 |

Com o perfil ECAPA tirado do limiar de agrupamento 0,2 (grupo dominante maior, 368 s, menos puro): entrevista C0 0,526 / 0,163; ADM C0 0,469 / 0,567 (margem 0,098) [verificado].

Matriz completa grupo × grupo das 4 gravações (ECAPA, grupos ≥ 10 s) gerada por `cluster_matrix.py`. Pontos que pesam:

- Mesma voz em gravações diferentes: 0,48–0,58 (José Luiz palestra × entrevista), 0,57 (Monteiro 1975 × ADM).
- Mesma voz na mesma gravação, grupos diferentes: 0,6–0,94.
- Vozes diferentes: 0,05–0,25 na maioria; **mas 0,40–0,50 entre grupos da palestra do José Luiz e o ADM** (um grupo da palestra, C11, chega a 0,75 com o ADM). Hipóteses: canal parecido (gravações antigas de sessão, mesmo tipo de equipamento) ou outra voz misturada na palestra [inferido; só ouvindo se resolve].

## 6. Decisão por limiar T (margem 0,1; grupo ≥ 10 s) [verificado]

| Receita | T | Entrevista: quem responde | Entrevista: entrevistador | ADM: voz principal | Acertos / falsos positivos |
| --- | --- | --- | --- | --- | --- |
| ecapa | 0,4 | é o José Luiz ✔ | não sei ✔ | é o Monteiro ✔ | 2/2 reconhecidos, 0 FP |
| ecapa | 0,5 | não sei ✘ | não sei ✔ | é o Monteiro ✔ | 1/2, 0 FP |
| ecapa | 0,6 | não sei ✘ | não sei ✔ | não sei ✘ | 0/2, 0 FP |
| ecapa | 0,7 | não sei ✘ | não sei ✔ | não sei ✘ | 0/2, 0 FP |
| senko+ecapa | 0,4 e 0,5 | é o José Luiz ✔ (os 2 grupos) | não sei ✔ | não sei ✘ (margem 0,083) | 1/2, 0 FP |
| senko+ecapa | 0,6 e 0,7 | não sei ✘ | não sei ✔ | não sei ✘ | 0/2, 0 FP |
| senko (CAM++) | 0,4–0,6 | é o José Luiz ✔ | **é o José Luiz ✘ (FP)** | não sei ✘ | 1/2, 1 FP |
| senko (CAM++) | 0,7 | é o José Luiz ✔ | não sei ✔ | não sei ✘ | 1/2, 0 FP |

Sem a regra da margem, com T = 0,4 a receita ecapa daria também "é o José Luiz" para o ADM (0,405) — falso positivo. **Escolha honesta com estes dados: T = 0,4 + margem 0,1** (única combinação que acerta os dois sem falso positivo), sabendo que o caso negativo mais difícil (0,405) está colado no limiar e o positivo mais fraco (0,477) logo acima. Não é um limiar calibrado: com 2 oradores e 3 decisões não há como medir falso positivo ≤ 2 % (meta do KBC-071).

## 7. Amostras para o dono conferir

Conferir ouvindo: **as amostras do grupo "José Luiz" e "Monteiro" são mesmo deles? as outras não?** Tempos em mm:ss da gravação de teste; texto = primeiras palavras do Whisper.

**Entrevista com M. Zé Luiz, Sergio Melo** (`2d3a3fdf-…`):

| Grupo (ecapa / senko) | Decisão | Início–fim | Primeiras palavras |
| --- | --- | --- | --- |
| C0 / SPEAKER_01 | é o José Luiz | 00:18–00:25 | "E ele me pediu para buscar um tijolo na olaria do Sr. Gabriel" |
| C0 / SPEAKER_01 | é o José Luiz | 05:10–05:16 | "Porque quando eu vi ele doutrinando, explicando, falando coisas assim que só…" |
| C0 / SPEAKER_01 | é o José Luiz | 11:10–11:13 | "Se existe alguma pessoa que bebe o vegetal na União do Vegetal…" |
| C0 / SPEAKER_02 (2º grupo do Senko) | é o José Luiz | 00:09–00:15 | "Simplesmente, foi um empregado de uma empresa de construção civil…" |
| C0 / SPEAKER_02 | é o José Luiz | 11:56–11:58 | "E que assim é que é a União do Vegetal" |
| C1 / SPEAKER_03 | não sei | 00:00–00:05 | "Mestre José Luiz, o senhor está lembrado das circunstâncias que o trouxeram…" |
| C1 / SPEAKER_03 | não sei | 05:40–05:46 | "Qual seria então a mensagem que o senhor daria a esses discípulos…" |
| C1 / SPEAKER_03 | não sei | 06:29–06:33 | "Ele foi um dos responsáveis pela confecção do Estatuto da União do…" |

**ADM MESTRE MONTEIRO** (`c78d227f-…`):

| Grupo (senko) | Decisão (ecapa) | Início–fim | Primeiras palavras |
| --- | --- | --- | --- |
| SPEAKER_01 | é o Monteiro | 00:00–00:10 | "Eu sou de naturalidade amazonense, lugar denominado Larginho, o Maitá, Amazona." |
| SPEAKER_01 | é o Monteiro | 01:31–01:36 | "motivo pelo qual solicitou ao mestre Gabriel" |
| SPEAKER_01 | é o Monteiro | 05:06–05:09 | "com algumas comunicações" |
| SPEAKER_02 | não sei | 03:45–03:48 | "Eu quero que o senhor leia este trecho aqui também" |
| SPEAKER_02 | não sei | 06:18–06:26 | (fala curta; Whisper: "sobre") |
| SPEAKER_02 | não sei | 07:40–07:42 | "falar em outros assuntos" |

Ponto a confirmar no ADM: a voz principal **lê** um texto na primeira pessoa, a pedido de outra voz ("leia este trecho"). Se quem lê não for o próprio Monteiro, o "acerto" desta gravação é falso e a conclusão muda [inferido; só o dono confirma].

## 8. Tempo de máquina [verificado]

| Passo | Palestra JL (28:38) | Entrevista (12:04) | Monteiro 1975 (6:40) | ADM (10:50) | Por hora de áudio |
| --- | --- | --- | --- | --- | --- |
| ECAPA base (VAD + vetores no MPS + agrupamento, inclui carregar o modelo) | 5,4 s | 2,8 s | 1,4 s | 2,3 s | **11–14 s/h** |
| ECAPA na CPU (só a referência de 1975) | — | — | 157 s | — | 1.411 s/h (não usar) |
| Senko (diarização, modelo já carregado) | 3,2 s | 0,5 s | 0,2 s | 0,4 s | **2–7 s/h** (+ ~9,5 s para carregar; 31 s na primeira vez) |
| Transcrição mlx-whisper turbo (pt, palavras) | 151 s | 21 s | 17 s | 18 s | **100–153 s/h**; 317 s/h na palestra ruim (alucinação alonga) |
| Reconhecimento (cossenos) | — | — | — | — | desprezível |

A transcrição domina o tempo; diarização e reconhecimento somam menos de 20 s por hora de áudio.

## 9. Limites

- **Sem marcação do dono, sem DER**: os números de grupos e tempos de fala não dizem quanto da fala foi atribuída à voz errada. O DER (FR-5, AC-5) continua pendente da marcação de 10 min por gravação (seção 10.1 do relatório de métodos).
- **Amostra mínima**: 2 oradores, 2 perfis, 3 decisões. Não dá para estimar acerto ≥ 90 % e falso positivo ≤ 2 % (KBC-071). O T = 0,4 é ponto de partida.
- **ECAPA treinado no VoxCeleb** (celebridades, maioria em inglês, áudio de vídeo); nossas gravações são antigas, de sessão, em pt-BR. Os cossenos da mesma pessoa entre gravações (0,48–0,58) ficam bem abaixo do que o VoxCeleb sugere [inferido].
- **Qualidade de gravação**: a palestra do José Luiz é ruim (Whisper alucina) e tem outra voz no fim; o perfil saiu de uma parte dela (C0, 124 s). Ruído de canal parecido entre gravações antigas pode aproximar vozes diferentes (0,40–0,50 entre palestra e ADM).
- **Rótulo por segmento do Whisper** (não por palavra): suficiente para conferência, não para cortar faixas.
- **pyannote `community-1` não testado**: acesso controlado no Hugging Face e não há token. **Nemotron 3** não testado (só roda via Swift/CoreML, fora do escopo deste teste).
- Senko roda o VAD e a segmentação da pyannote 3.0 convertidos; não testamos o modo `accurate`.

## 10. O que muda nos itens

- **KBC-064 (separação de vozes)**: **Senko** passa a ser o candidato mais forte entre os que rodaram — separou nas 4 gravações as vozes que a transcrição mostra (inclusive a 2ª voz de 13 s do ADM e a homenagem no fim da palestra), em 2–7 s por hora de áudio, MIT, Python. Pontos fracos: partiu a voz de quem responde na entrevista em 2 grupos (juntar grupos com cosseno ECAPA ≥ 0,8 resolveria [inferido]). A comparação com o `community-1` fica pendente do token; a decisão final pede o DER com a marcação do dono.
- **KBC-071 (reconhecimento de pessoas)**: **ECAPA** (SpeechBrain, Apache-2.0) para o vetor do perfil e da voz a reconhecer; **não** usar os centróides CAM++ do Senko para isso (deram falso positivo). Regra inicial: **T = 0,4, margem ≥ 0,1 para o 2º perfil, grupo com ≥ 10 s de fala**, sempre como sugestão. Antes de ligar para o usuário: calibrar com ≥ 5 oradores e ≥ 2 gravações cada (inclusive vozes de plateia e de leitores) para medir falso positivo; perfil a partir de trecho limpo e de ≥ 2 gravações (a palestra ruim puxou o perfil do José Luiz para perto do ADM); considerar normalização de escore com uma coorte de outras vozes do acervo [inferido]. Se o `community-1` for liberado, comparar os vetores WeSpeaker dele com o ECAPA no mesmo teste.
- **Receita combinada recomendada para o próximo teste**: grupos do Senko + vetores ECAPA dentro de cada grupo (senko+ecapa) — separação do Senko com o reconhecimento do ECAPA; aqui ficou a uma margem de 0,017 de reconhecer também o Monteiro [verificado].

## 11. Scripts e dados

Scripts em [`scripts/`](scripts/) (sem áudio, transcrição ou vetores no repositório; os dados ficam em `~/dev/personal/kb-chat-research/`):

| Script | Faz |
| --- | --- |
| `prepare_audio.sh` | m4a do acervo (só leitura) → WAV 16 kHz mono |
| `diarize_ecapa.py` | base: Silero VAD + ECAPA em janelas 1,5/0,75 s + aglomerativo por cosseno + absorção de grupos < 10 s |
| `diarize_senko.py` | diarização com Senko; guarda grupos e centróides CAM++ |
| `transcribe.py` | mlx-whisper large-v3-turbo, pt, tempo por palavra |
| `recognize_speakers.py` | perfis das referências × grupos dos testes, nas 3 receitas, decisões por T |
| `cluster_matrix.py` | matriz completa de cosseno entre grupos das 4 gravações |
| `label_transcript.py` | voz por segmento do Whisper e 3 amostras por grupo para conferência |

Reproduzir (de `~/dev/personal/kb-chat-research`, com `S=<worktree>/docs/research/scripts`): `bash $S/prepare_audio.sh . joseluiz_ref=8ef7ed49-b61d-445f-833d-17009e56a0c7 joseluiz_test=2d3a3fdf-f409-4cad-b4a0-b648e1c249d6 monteiro_ref=18469445-ca74-4d36-8e69-f368fc78018e monteiro_test=c78d227f-76b8-4337-9012-f913ed7a2819`; para cada gravação `.venv/bin/python $S/diarize_ecapa.py audio/<n>.wav out/ecapa_<n>_t0.3 --threshold 0.3`, `.venv/bin/python $S/diarize_senko.py audio/<n>.wav out/senko_<n>` e `.venv/bin/python $S/transcribe.py audio/<n>.wav out/tx_<n>.json`; depois `.venv/bin/python $S/recognize_speakers.py out t0.3`. Os perfis ficam só nessa pasta de pesquisa e devem ser apagados ao fim do teste (seção 10.1 do relatório de métodos).
