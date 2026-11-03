---
id: KBC-063
title: "Pesquisa: como dividir palestras em perguntas e respostas, identificar quem fala e dar títulos com IA, de forma prática, rápida e barata (artigos, YouTube e os repositórios de Fabio Akita)"
status: ready
slice: phase-2-editing
outcome: as decisões técnicas da edição de áudio (KBC-064 a KBC-071) saem de evidência comparada, com custo por hora de áudio medido, e não de palpite
depends_on: []
---

# KBC-063 — Pesquisa da edição de áudio com IA

## Story
Como dono, quero uma pesquisa em artigos, textos e vídeos do YouTube (começando por quem já tem experiência, como Fabio Akita) e nos projetos públicos que já fazem isso, para escolher o jeito mais prático, rápido e barato de dividir as gravações em perguntas e respostas, identificar quem fala e titular as faixas, antes de construir.

## Scope
**In:** pesquisa web com a skill `devflow-core:web-research` (Firecrawl), autores renomados primeiro (Fabio Akita; também Rodrigo Branas e Nauck, de quem o dono gosta; outros achados pela busca); vídeos do YouTube sobre o tema; levantamento dos repositórios públicos de Fabio Akita (`github.com/akitaonrails`) que façam transcrição, separação de vozes, cortes, títulos ou classificação, só para aprender; comparação das opções de: (1) separação de vozes (diarização) no Mac do dono; (2) identificação de pessoas pela voz; (3) detecção de pergunta e resposta e cortes em faixas; (4) títulos e classificação por assunto; (5) modelos locais × APIs baratas × lotes; (6) **benchmark de produtos** que já fazem isso (Descript, Otter.ai, Riverside, Podcastle, Adobe Podcast, Trint, Sonix, Rev, Fireflies, capítulos automáticos do YouTube, do Spotify e do Apple Podcasts, e front-ends abertos do Whisper como WhisperX, noScribe, Buzz e MacWhisper): boas experiências, o que não funciona e não devemos reproduzir, e boas práticas de opções no envio, revisão e correção de falantes e de limites de faixa, desfazer, exibição de confiança e edição de títulos na linha (alimenta o KBC-072); relatório em `docs/research/`; o que vale guardar no vault de pesquisa do `kb` (tópico `audio-editing`), como a skill manda; um teste pequeno com 2 gravações do acervo (uma palestra com perguntas da plateia e uma conversa a dois) para medir o que for decisivo.
**Out:** implementar qualquer parte no produto (KBC-064 em diante); clonar repositórios de terceiros dentro do `kb-chat` ou rodar código deles na máquina do dono sem isolamento; gastar mais que o teto abaixo.

## Business rules
- BR-1: cada afirmação do relatório traz a fonte (URL e data de acesso) e é marcada como `[verificado]`, `[observado por terceiros]` ou `[inferido]`, como nos benchmarks anteriores (`docs/research/2026-10-29-media-library-benchmark.md`).
- BR-2: o custo por hora de áudio é critério obrigatório de comparação em toda opção (US$/h, com a conta mostrada), ao lado de qualidade e tempo de máquina.
- BR-3: código de terceiros só é lido (README, código-fonte no GitHub); nada é copiado para o repositório sem checar a licença; licença GPL/AGPL marca a opção como "só ideia, sem reaproveitar código".
- BR-4: o gasto da pesquisa (Firecrawl, `kb`, chamadas de IA no teste) fica em até US$ 5, registrado no relatório (regra de custo do projeto).
- BR-5: o teste com gravações reais usa só áudios já no acervo e roda no Mac do dono; nenhum áudio vai para API de terceiros sem o dono marcar quais podem ir.

## Functional requirements
- FR-1: O relatório deve ter, para cada uma das 5 frentes do escopo, uma tabela de opções com: o que é, fonte, qualidade relatada ou medida, tempo de máquina por hora de áudio, custo por hora de áudio, licença, roda no Mac (Apple Silicon) sim/não, e a recomendação. (BR-1, BR-2)
- FR-2: O relatório deve ter uma seção "Fabio Akita": vídeos e posts dele sobre o tema e os repositórios públicos avaliados (nome, URL, o que faz, o que dá para aprender, licença), aprofundando a primeira passada listada nas Referências. (BR-3)
- FR-3: O relatório deve ter uma seção "Outros autores do YouTube" com pelo menos 5 vídeos de autores diferentes (renomados primeiro), cada um com título, autor, URL, data e a técnica prática que ensina.
- FR-4: O relatório deve fechar com "Decisões que alimenta": para cada item KBC-064 a KBC-071, a escolha recomendada (modelo, ferramenta, prompt, limiar) e o que muda no item; a ADR 0029 ganha a revisão que couber.
- FR-5: O teste com as 2 gravações deve medir: erro de diarização (DER) contra uma marcação feita pelo dono em 10 minutos de cada uma, tempo de máquina, e a qualidade das faixas propostas por 2 abordagens (modelo local e API barata) num gabarito de perguntas e respostas feito pelo dono. (BR-5)
- FR-7: O relatório deve ter a seção "Benchmark de produtos" com, por produto: o que faz bem, o que evitar (com o relato de onde veio), a fonte, e uma lista final de boas práticas e antipadrões citada pela spec do KBC-072, aprofundando a primeira passada abaixo. (BR-1)
- FR-6: O que vale guardar (artigos e vídeos de referência) deve entrar no vault de pesquisa do `kb`, tópico `audio-editing`, pelo fluxo da skill `devflow-core:web-research`.

## Non-functional requirements
- NFR-1: o relatório cabe em uma leitura de 15 minutos (resumo executivo de 1 página no topo).
- NFR-2: gasto total ≤ US$ 5 (BR-4), medido pelos saldos antes e depois.

## Acceptance criteria
- **AC-1** (FR-1, BR-2): Given o relatório publicado, When o dono abre a tabela de diarização, Then cada opção tem custo por hora de áudio com a conta, e pelo menos uma opção roda local no Mac sem custo.
- **AC-2** (FR-2, BR-3): Given a seção "Fabio Akita", When o dono a lê, Then cada repositório tem licença e a marca "dá para reaproveitar" ou "só ideia".
- **AC-3** (FR-3): Given a seção de autores, When contada, Then há ≥ 5 vídeos de autores diferentes, cada um com URL e técnica.
- **AC-4** (FR-4): Given a seção "Decisões que alimenta", When comparada com os itens KBC-064 a KBC-071, Then cada item tem uma recomendação ou "nada muda".
- **AC-5** (FR-5, BR-5): Given as 2 gravações e a marcação do dono, When o teste roda, Then o relatório mostra DER, tempo de máquina e acerto das faixas por abordagem; nenhum áudio saiu do Mac sem o dono ter marcado.
- **AC-6** (BR-1, negativo): Given uma afirmação sem fonte, When o relatório é revisado, Then ela é removida ou marcada `[inferido]`.
- **AC-8** (FR-7): Given a seção "Benchmark de produtos", When comparada com a lista do escopo, Then cada produto tem "faz bem", "evitar" e fonte, e a lista de boas práticas cita de qual produto vem cada uma.
- **AC-7** (BR-4, limite): Given o gasto chegando a US$ 5, When falta parte do teste, Then a pesquisa para essa parte e o relatório diz o que ficou sem medir.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-4, AC-6, AC-8 | revisão do documento (checklist no `qa.md`) | |
| AC-5 | medição manual no Mac, scripts em `docs/research/scripts/` | marcação do dono como gabarito |
| AC-7 | registro dos saldos no relatório | |

## References
Pedido do dono (2026-11-03): "para esta task vamos precisar fazer uma busca em artigos, textos e em vídeos do youtube de maneiras para fazer isso / uma pessoa que já tem experiência com isso é Fabio Akita"; "pesquisar no repositório público dele projetos que já façam isso para pegar o aprendizado"; "pesquisar também outros autores de vídeos no youtube para pegar referências de como fazer isso com AI de forma prática, rápida e com o menor custo possível". · ADRs 0022, 0023, 0024, 0029 · Piloto da transcrição: `docs/research/2026-10-28-transcription-pilot.md`

### Primeira passada (2026-11-03, a aprofundar quando o item rodar)

Repositórios de `akitaonrails` (204 públicos, listados com `gh repo list` e `gh search repos`; só leitura). Nenhum faz diarização ou cortes de pergunta e resposta; os candidatos ensinam o padrão:

| Repositório | O que faz | O que aprender | Licença |
|---|---|---|---|
| [FrankSherlock](https://github.com/akitaonrails/FrankSherlock) | Cataloga e busca mídia local com IA (modelo de visão no Ollama, OCR, SQLite FTS5); agrupa rostos em pessoas que o usuário nomeia e funde | O mesmo fluxo que queremos para vozes: agrupar → a pessoa nomeia → buscar por pessoa; pastas `_research_ab_test` e `_face_ab_test` com bancada A/B e gabarito (`ground_truth_audio.json`; Whisper small × faster-whisper na fase de áudio) antes de integrar | GPL-3.0 (só ideia) |
| [easy-subtitle](https://github.com/akitaonrails/easy-subtitle) | CLI de extrair, baixar e sincronizar legendas (alass/ffsubsync) | Sincronizar texto com áudio; post "Portando 10 mil linhas de Python pra Crystal com Claude" | sem licença declarada (só ideia) |
| [llm-opensource-benchmark](https://github.com/akitaonrails/llm-opensource-benchmark) e [llm-non-coding-benchmark](https://github.com/akitaonrails/llm-non-coding-benchmark) | Bancadas de modelos locais e comerciais (velocidade, primeiro token, qualidade) | Como medir modelo local × API para a tarefa de faixas e títulos | sem licença declarada |
| [ai-usagebar](https://github.com/akitaonrails/ai-usagebar) | Mostra saldo de planos e créditos (Claude, OpenRouter…) | Custo visível | sem licença declarada |
| [my-skills](https://github.com/akitaonrails/my-skills) | Skills pessoais de agentes | Nenhuma de transcrição na primeira passada | sem licença declarada |

Posts e vídeos achados numa busca rápida no Firecrawl (a verificar):

| Título | Autor | URL | Por que interessa |
|---|---|---|---|
| Vibe Code: Do Zero à Produção em 6 dias | Fabio Akita | https://www.akitaonrails.com/2026/02/16/vibe-code-do-zero-a-producao-em-6-dias-the-m-akita-chronicles/ | Cita um gerenciador pessoal de conhecimento que recebe áudio e transcreve com Whisper |
| Vibe Code: Fiz um Indexador Inteligente de Imagens com IA em 2 dias | Fabio Akita | https://www.akitaonrails.com/2026/02/23/vibe-code-fiz-um-indexador-inteligente-de-imagens-com-ia-em-2-dias/ | Bastidores do FrankSherlock (classificação local, agrupar e nomear pessoas) |
| [Akitando] #148 — O que IAs podem fazer? Exemplos de ferramentas | Fabio Akita | https://www.akitaonrails.com/2023/11/29/akitando-148-o-que-ias-podem-fazer-exemplos-de-ferramentas/ | Legendas automáticas e ferramentas de áudio com IA |
| Como a ElevenLabs não foi morta pelo Qwen3 TTS | Fabio Akita | https://www.akitaonrails.com/2026/04/09/como-a-elevenlabs-nao-foi-morta-pelo-qwen3-tts/ | Experiência real com modelo local de áudio × serviço pago, custo |
| Multi Speaker Transcription with Speaker IDs with Local Whisper | (autor a confirmar) | https://www.youtube.com/watch?v=SAIsk0i7KgU | Whisper local com identificação de falantes |
| Build Speaker-Aware AI: OpenAI Whisper + Pyannote | (autor a confirmar) | https://www.youtube.com/watch?v=AoIExPkxkyk | Juntar transcrição e diarização |
| ChatGPT + Chapters = More Podcast Listeners | (autor a confirmar) | https://www.youtube.com/watch?v=CPEtmPhccbs | Capítulos com título a partir da transcrição |
| Show HN: Local audio transcription and speaker ID for Apple Silicon | (HN) | https://news.ycombinator.com/item?id=44768065 | MLX Whisper + pyannote no Mac |
| whispermlx (fork do WhisperX para MLX) | KalebJS | https://github.com/KalebJS/whispermlx | Transcrição com falantes no Apple Silicon |
| Chapter-Llama: capítulos em vídeos de 1 h com LLM | arXiv 2504.00072 | https://arxiv.org/html/2504.00072v1 | Cortes e títulos de vídeos longos com LLM, eficiência |

Rodrigo Branas: canal https://www.youtube.com/rodrigobranas (IA no processo de desenvolvimento; nada específico de áudio na primeira passada).

Pedro Nauck: canal https://www.youtube.com/pedronauck (informado pelo dono). Co-instrutor com Rodrigo Branas da Formação Inteligência Artificial (https://branas.io/formacoes/inteligencia-artificial), cujo módulo de LLMs trata de tipos de modelos, custos, contexto, cache e execução local, o critério de custo deste item. Vídeos achados na primeira passada, sobre agentes e não sobre áudio, para o método:

| Título | URL | Por que interessa |
|---|---|---|
| Loop determinístico ou agêntico? A escolha que decide… | https://www.youtube.com/watch?v=MkxbXNUBwuQ | Quando um fluxo fixo (transcrever → vozes → faixas) vence um agente, o que pesa em custo |
| Eu descobri o SEGREDO de como fazer a IA programar certo! | https://www.youtube.com/watch?v=gRd0bw6Yyhk | Contexto e estado entre janelas: o mesmo problema de propor faixas em janelas de uma gravação longa |
| Jev: o modelo de IA mais revolucionário de 2026 | canal (lista de vídeos) | Modelos novos e custo; conferir se cobre modelo local |

### Benchmark de produtos — primeira passada (2026-11-03, a aprofundar)

Fontes: páginas de ajuda dos produtos e relatos de usuários achados no Firecrawl; tudo `[observado por terceiros]` até a pesquisa aprofundar.

| Produto | O que faz bem | O que evitar | Fonte |
|---|---|---|---|
| Descript | Detecta as vozes e pede para nomear cada uma uma vez; toca um trecho de cada voz para a pessoa reconhecer ("Speaker Detective") e aplica o nome no texto todo | Usuários relatam "só detectou um falante" em gravação de um canal só; a correção é refazer a detecção | https://help.descript.com/script-editing/speaker-detection · https://convertaudiototext.com/blog/best-transcription-with-speaker-detection |
| Otter.ai | "Speaker 1, 2…" e "Unknown Speaker" renomeáveis; o nome dado se espalha pelos trechos da mesma voz; aprende a voz para conversas futuras | Aprender a voz sem consentimento explícito de quem fala (o nosso KBC-071 exige); parágrafos misturando duas vozes pioram tudo depois, a própria ajuda pede para corrigir | https://help.otter.ai/hc/en-us/articles/21665587209367-Speaker-Identification-Overview · https://help.otter.ai/hc/en-us/articles/37817241040535-Best-Practices-to-Maximize-Speaker-Identification |
| Riverside | Ao fim da gravação, a página do projeto já mostra o que a IA gerou (cortes, notas, capítulos) | Cortes "mais compartilháveis" escolhidos pela IA, sem a pessoa decidir; limite de conjuntos por plano | https://riverside.com/ · https://blitzcutai.com/blog/riverside-magic-clips-review-2026 |
| Adobe Podcast | Transcrição e edição pelo texto no navegador | Uma faixa com várias pessoas virou um falante só; "sem distinguir falantes, a edição pela transcrição fica praticamente inutilizável" (relato na comunidade) | https://helpx.adobe.com/podcast/adobe-podcast-faq.html · https://community.adobe.com/questions-514/podcast-not-separating-speakers-1498743 |
| Rev | Clicar no rótulo do falante abre o menu para renomear ali mesmo | Não garante os rótulos; a correção é toda manual | https://support.rev.com/hc/en-us/articles/29824992702989-Transcription-Editor |
| Fireflies | Edição dos rótulos em arquivos enviados | Nomes errados contaminam o que vem depois (tarefas, resumos); exige conferência humana | https://guide.fireflies.ai/articles/1234873612-how-to-edit-speaker-labels-in-uploaded-files · https://www.finlaz.com/fireflies-ai-ai-transcription-errors-misheard-names-scramble-crm-tasks/ |
| Trint e Sonix | Editor de texto bom, marcação de tempo | Identificação de falantes "não perfeita" nas comparações; preço por hora alto | https://sonix.ai/resources/best-transcription-tools-to-convert-audio-to-text/ |
| YouTube (capítulos automáticos) | Capítulos gerados por aprendizado de máquina, que o criador pode desligar; a lista manual sempre vence a automática | Gerar sem o criador pedir | https://support.google.com/youtube/answer/9884579 · https://gyre.pro/blog/youtube-video-chapters-how-to-add-them-why-they-increase-views |
| Spotify (capítulos automáticos) | Títulos e inícios escolhidos da transcrição, editáveis pelo criador; aviso de que foram gerados | Ouvintes acham títulos sem sentido ("parecem um histórico de busca") e capítulos extras aparecendo sozinhos | https://support.spotify.com/us/creators/article/episode-chapters/ · https://community.spotify.com/t5/Podcast-Discussion/Extra-Chapters-Auto-Adding-on-Podcasts/td-p/7138990 |
| Apple Podcasts | Gera capítulos só quando o criador não forneceu; o criador pode desligar | — (a regra é a boa prática) | https://podcasters.apple.com/support/5482-using-chapters-on-apple-podcasts · https://www.reddit.com/r/podcasting/comments/1qvygvi/ |
| noScribe (aberto) | Whisper + pyannote local, com um editor próprio para revisar e corrigir falantes, sobreposições e tempos | Interface de desktop, sem web | https://github.com/kaixxx/noScribe |
| MacWhisper | Tudo local no Mac | Separação de vozes ainda beta, "pede limpeza" | https://www.getvoibe.com/resources/macwhisper-review/ · https://docs.macwhisper.com/article/32-automatic-speaker-recognition-in-macwhisper |
| Buzz (aberto, MIT) | Transcrição offline simples | Sem separação de vozes na primeira passada | https://github.com/chidiwilliams/buzz |
| WhisperX (aberto) | Whisper com alinhamento por palavra e pyannote; usado por noScribe e por forks no Mac (whispermlx) | A conferir na pesquisa | https://github.com/KalebJS/whispermlx |

Boas práticas tiradas da primeira passada (usadas no KBC-072): nomear cada voz uma vez, com uma amostra para ouvir, e espalhar o nome; mostrar que algo foi gerado pela IA até a pessoa aceitar; o que a pessoa fez vence o automático e nunca é sobrescrito; gerar só quando pedido. Antipadrões: gerar e publicar sozinho; títulos sem sentido sem revisão; aprender a voz sem consentimento; uma falha que obriga a refazer tudo.

## Open questions
Nenhuma que bloqueie. Premissa: o dono escolhe as 2 gravações do teste e faz a marcação de 10 minutos de cada uma (cerca de 40 minutos dele).

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (sem tela)
- [x] Dependencies done; no open questions
- [x] Fits one goal
