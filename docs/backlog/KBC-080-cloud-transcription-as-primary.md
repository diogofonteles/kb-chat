---
id: KBC-080
title: "Transcrever sem o Mac: provedor na nuvem como local principal possível, com teste de qualidade em pt-BR antes de liberar (WER nos trechos do piloto) e escolha do modelo"
status: draft
slice: phase-3-server-processing
outcome: com o Mac desligado, um áudio de 1 h é transcrito em ≤ 30 min do envio, com erro de palavras ≤ 10 % nos trechos limpos do piloto e nomes da lista de termos certos, por ≤ US$ 0,12 por hora de áudio
depends_on: [KBC-079, KBC-037, KBC-040]
---

# KBC-080 — Transcrever sem o Mac

## Story
Como pessoa que envia palestras, quero que a transcrição aconteça mesmo quando o Mac do dono está desligado, com a mesma qualidade em português, para o áudio ficar pesquisável no mesmo dia.

## Scope
**In:** o adaptador de transcrição do KBC-037 generalizado para "provedor de transcrição" (interface única: cortes, termos, resultado bruto, custo real), com o Groq `whisper-large-v3-turbo` e `whisper-large-v3` como modelos escolhíveis; o teste de qualidade em pt-BR: rodar os 3 trechos do piloto pelo provedor com cortes VAD ≤ 28 s e termos em cada corte, calcular WER e acertos de termos com o script do piloto, e gravar o resultado no relatório da tela; um provedor/modelo só pode ser o **primeiro** local de `transcribe` se passou no teste (WER ≤ 10 % nos limpos juntos); custo real por pedido no livro da mídia; legenda e confiança iguais (o JSON bruto segue a ADR 0023 §4, com `provider` e `model`).
**Out:** outros provedores (OpenAI, Deepgram, AssemblyAI: só se o teste do Groq falhar, num item novo); GPU alugada (KBC-085); separar vozes (KBC-081); a regra de privacidade (KBC-078).

## Business rules
- BR-1: só roda para acervos que permitem transcrição fora (KBC-078) e quando o provedor está na lista de `transcribe` (KBC-079).
- BR-2: o provedor só pode ser o primeiro local de `transcribe` se o teste de qualidade passou nos últimos 90 dias com o mesmo modelo e a mesma versão dos parâmetros; senão aparece só como reserva, com "Qualidade não conferida".
- BR-3: cada pedido reserva o custo antes de sair (mínimo cobrado do provedor incluído) e o real é lançado depois; o que sobrar volta (ADR 0022 §7).
- BR-4: o plano gratuito, quando existe, é usado primeiro e o ritmo dele é respeitado (KBC-037 FR-3); passar ao pago exige que o master tenha marcado "Usar o plano pago quando o gratuito acabar".
- BR-5: a mídia diz por quem foi transcrita; uma retranscrição (KBC-040) pode escolher o local.

## Functional requirements
- FR-1: O adaptador deve mandar os cortes do VAD (≤ 28 s, sem VAD quando a fala < 40 %, ADR 0023 §3) com a lista de termos em cada pedido, juntar o resultado com os deslocamentos e entregar o JSON bruto como o transcritor do Mac. (BR-1)
- FR-2: "Testar qualidade" (master) deve transcrever os 3 trechos de referência do piloto pelo provedor e modelo escolhidos, calcular WER (mesma normalização do piloto) e acertos dos termos, e gravar data, modelo, parâmetros, WER por trecho e custo. (BR-2)
- FR-3: A tela "Processamento" (KBC-079) deve mostrar o último teste de cada modelo e recusar pôr como primeiro um modelo reprovado ou sem teste. (BR-2)
- FR-4: O custo real de cada pedido deve vir da resposta ou da tabela de preço gravada na configuração, lançado no livro mensal da mídia. (BR-3)
- FR-5: Com o plano gratuito esgotado e "Usar o plano pago" desmarcado, o trabalho deve esperar até a janela seguinte, com "Limite gratuito do Groq; volta às <hora>". (BR-4)

## Non-functional requirements
- NFR-1: WER ≤ 10 % nos trechos limpos juntos (o Mac fez 7,1 %); nos 40 "Tiuaco" e 43 "Hoasca" de referência, ≥ 90 % com a grafia da lista.
- NFR-2: 1 h de áudio transcrita em ≤ 30 min do início no plano pago, ≤ 2 h no gratuito (ritmo de 2 h de áudio por hora).
- NFR-3: custo ≤ US$ 0,12 por hora de áudio (turbo ≈ US$ 0,04; large-v3 a conferir), medido pelo livro num mês de teste e conferido com o painel do provedor (diferença ≤ 5 %).

## Acceptance criteria
- **AC-1** (FR-1, BR-1): Given um acervo que permite e `transcribe` = [Groq], When um áudio de 10 min é enviado, Then a transcrição sai com tempo por palavra, legenda e "Transcrito pelo Groq (whisper-large-v3-turbo)".
- **AC-2** (FR-2, NFR-1): Given o provedor falso devolvendo os textos do piloto, When o master clica "Testar qualidade", Then o relatório mostra WER por trecho e o veredito "Aprovado" ou "Reprovado" pelo limite de 10 %.
- **AC-3** (BR-2, FR-3, negativo): Given um modelo sem teste, When o master tenta pô-lo em primeiro em `transcribe`, Then a tela recusa com "Qualidade não conferida: rode Testar qualidade".
- **AC-4** (FR-1): Given uma faixa com "Hoasca", When transcrita, Then o servidor falso confere a lista de termos no `prompt` de cada corte.
- **AC-5** (BR-3, FR-4): Given 1 h enviada, When termina, Then o livro mostra a reserva e o custo real, e a sobra volta.
- **AC-6** (BR-4, FR-5): Given o limite diário gratuito atingido e "Usar o plano pago" desmarcado, When chega um trabalho, Then ele espera com a hora de volta e nada é cobrado.
- **AC-7** (BR-1, negativo): Given um acervo `Não`, When o Mac está parado, Then nada vai ao provedor (repete o AC-1 do KBC-078 com o adaptador novo).
- **AC-8** (BR-5): Given uma mídia transcrita no Mac, When um master pede "Transcrever de novo" escolhendo Groq, Then nasce uma versão nova com o provedor e a anterior fica.
- **AC-9** (confiança): Given a gravação ruidosa do piloto, When transcrita pelo provedor, Then a confiança sai `low` com o aviso de sempre.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-5, AC-6, AC-7, AC-8 | integração | provedor falso, relógio falso |
| AC-2, AC-3 | integração + E2E | WER com os textos do piloto como fixture |
| AC-4 | unitário (adaptador) | servidor falso confere o `prompt` |
| AC-9 | integração | fixture da gravação ruidosa |
| NFR-1, NFR-2, NFR-3 | manual, 1 rodada real | trechos do piloto no Mac do dono (fora do git); gasto ≤ US$ 1 |

## References
ADR: [0031](../adr/0031-processing-location-per-step.md), [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) (§3 a §7) · Pesquisa: [piloto de transcrição](../research/2026-10-28-transcription-pilot.md) · Itens: KBC-037, KBC-040, KBC-078, KBC-079

## Open questions
- Qual provedor e modelo? Padrão recomendado: Groq, `whisper-large-v3-turbo` (US$ 0,04/h, medido no piloto) e `whisper-large-v3` testado lado a lado; fica o que passar no teste com o menor custo. — owner: dono
- Pode usar o plano pago quando o gratuito acabar? Padrão recomendado: sim, dentro dos tetos (mídia US$ 10/mês; por acervo US$ 5/mês). — owner: dono

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (ADR 0031 proposta)
- [ ] Dependencies done or scheduled; no open questions
- [x] Fits one goal
