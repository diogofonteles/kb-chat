# Piloto de transcrição — fase 2 (2026-10-27/28)

Relatório resumido. O relatório completo, os áudios, as transcrições brutas, as legendas, as planilhas e os scripts ficam no Mac do dono (`~/dev/personal/nova-alexandria-pilot/`, fora do git, com `report/relatorio.md` e `out/*.csv`).

## Pergunta

A transcrição automática das palestras em português serve para legenda e busca (erro de palavras ≤ 10 %, sem frases inventadas, tempos bons)? A VM converte e monta compilados sem travar o site? O acervo cabe nos 100 GB grátis?

## Material

111 faixas MP3 dos CDs "A palavra do mestre" (UDV), 5,59 h, 44,1 kHz estéreo 160 kbps, faixas de 3 min em média (máximo 13 min). Inclui narrativas, vários falantes, chamadas cantadas e gravações antigas ruidosas. Lista de termos inicial com 25 termos aprovada pelo dono; 7 termos a mais testados depois (Tiuaco, Mariri, Chacrona, Rei Zinca, Rei Salomão, Associação Beneficente União do Vegetal, diretoria).

## Variantes

| Variante | O que é |
|---|---|
| Mac sem VAD | mlx-whisper 0.4.3, large-v3-turbo, tempo por palavra, temperaturas com recuo, sem VAD, sem termos, sem filtro |
| Mac com VAD | + Silero VAD (cortes ≤ 28 s), lista de termos em cada corte, filtro pós-transcrição |
| Mac com VAD e lista ampliada | o anterior com os 7 termos a mais, só nas faixas dos trechos |
| Groq sem VAD | `whisper-large-v3-turbo` na API do Groq, MP3 original (21 faixas, pelo limite diário do plano grátis) |
| Groq com VAD | só os cortes de fala num FLAC 16 kHz, termos uma vez por arquivo, filtro |

## Erro de palavras (WER)

Referência: 3 trechos de ~10 min corrigidos à mão pelo dono em 2026-10-28. Normalização: minúsculas, sem pontuação, números por extenso.

| Variante | Narrativa limpa (826 palavras) | Várias vozes e chamadas (914) | Limpos juntos | Gravação ruidosa (690) |
|---|---|---|---|---|
| Mac sem VAD | 13,9 % | 16,3 % | 15,2 % | 91,9 % |
| Mac com VAD | **4,2 %** | 11,2 % | 7,9 % | 75,4 % |
| Mac com VAD e lista ampliada | 6,2 % | **8,0 %** | **7,1 %** | **73,5 %** |
| Groq sem VAD | 11,7 % | 13,9 % | 12,9 % | 80,6 % |
| Groq com VAD | 13,0 % | 16,0 % | 14,5 % | 82,6 % |

- **Viés:** o dono corrigiu a partir do texto do "Mac com VAD", o que o favorece. A ordem das variantes é confiável; a distância exata, não.
- **Nomes dominam os erros em áudio limpo.** "Tiuaco" saiu errado nas 40 ocorrências sem estar na lista (Tioaco, Tiwaco, Tio Aco, Haku) e certo em todas com a lista ampliada. "Hoasca" foi de 0 para 43 acertos com a lista no Mac; no Groq, com os termos uma vez por arquivo, só 2.
- **A lista ampliada piorou a narrativa (4,2 → 6,2 %)** por um único laço de 7 palavras numa chamada cantada, que o filtro (laços de até 4 palavras) não pegou.
- **A gravação ruidosa fica ruim em todas as variantes**: o modelo inventa frases inteiras.

## Alucinações e repetições

As frases clássicas ("obrigado por assistir", "inscreva-se", prefixos em inglês, vazamento da lista) apareceram 0 vezes. O problema real são laços de repetição: Mac sem VAD em 9 faixas, Mac com VAD em 33 (1.810 palavras colapsadas pelo filtro), Groq com VAD em 17.

O VAD apaga as chamadas cantadas: 9 faixas com menos de 40 % de fala detectada e 3 vazias. Baixar o limiar do Silero ou normalizar o volume não resolveu; sem VAD essas faixas saem razoáveis.

## Velocidade e custo

| Onde | Velocidade | 500 h | 2.000 h | Custo |
|---|---|---|---|---|
| Mac ocioso (mlx) | 17× tempo real | ~29 h de máquina | ~115 h | US$ 0 |
| Groq, plano grátis | ~55× por pedido, mas 2 h de áudio por hora e 8 h por dia | ~57 dias | ~230 dias | US$ 0 |
| Groq, pago | idem sem o limite diário | horas | horas | US$ 0,04/h (mínimo 10 s por pedido): ~US$ 18–20 / ~US$ 73–80 |
| VM (faster-whisper small int8, 1 CPU) | RTF 0,55, erra nomes ("Oasta") | inviável | inviável | — |

O piloto usou 24.703 s da cota grátis do Groq: custo US$ 0.

## Legendas

O início das mesmas palavras difere em mediana 0,02 s entre Mac e Groq (p90 0,24 s). Regras propostas: nova linha em silêncio ≥ 0,5 s ou fim de frase; cue ≤ 6 s e ≤ 84 caracteres; palavra esticada limitada a 1,2 s; tempos de segmento quando faltam os de palavra.

## Tamanho

| Formato | Por hora | 500 h | 2.000 h |
|---|---|---|---|
| MP3 original 160 kbps | 72 MB | 36 GB | 144 GB |
| AAC 64k mono (escolhido) | 29,6 MB | 14,8 GB | 59,2 GB |
| Opus 48k mono | 21,6 MB | 10,8 GB | 43,3 GB |

## VM de produção

Contêiner temporário com 1 CPU e 2 GB, 1 h de áudio: AAC em 45–54 s, Opus em 65 s, `silencedetect` em 18 s, compilado de 10 min com 15 cortes em 7,3 s. O site respondeu HTTP 200 nas 64 checagens (latência média 0,38–0,40 s, máximo 2,4 s). Vídeo não foi testado. Tudo do teste foi removido da VM depois.

## Conclusões para a fase A

1. Transcrever no Mac do dono (mlx-whisper turbo, Silero VAD, cortes ≤ 28 s, lista de termos em cada corte), sem VAD quando a fala detectada for < 40 %. Groq como reserva, com os termos em cada corte. → ADR 0023, KBC-036, KBC-037.
2. Lista de termos editável pelo dono, com retranscrição. → KBC-040.
3. Filtro de laços de até 12 palavras repetidas 3 ou mais vezes. → ADR 0023.
4. Marcar transcrições de baixa confiança: pesquisáveis, com aviso. → ADR 0023, KBC-036.
5. AAC 64k mono; o áudio de 2.000 h cabe nos 100 GB grátis. → ADR 0022.
6. A VM serve para converter e montar compilados, não para transcrever. → ADR 0022.

Próximos testes, quando fizerem diferença: Groq com cortes de ≤ 28 s e termos em cada um; whisper large-v3 (não turbo) e redução de ruído nas gravações ruidosas; conversão de vídeo na VM.
