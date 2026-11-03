---
id: KBC-085
title: "GPU alugada sob demanda (Modal) para transcrever e separar vozes em lote: o nosso contêiner liga, processa e desliga, com custo por hora de áudio e teto"
status: draft
slice: phase-3-server-processing
outcome: um lote de 50 h de áudio é transcrito e tem as vozes separadas sem o Mac em ≤ 4 h, por ≤ US$ 0,08 por hora de áudio, só em acervos que permitem
depends_on: [KBC-079, KBC-078, KBC-080, KBC-081]
---

# KBC-085 — GPU alugada sob demanda

## Story
Como master que importa um acervo grande, quero processar o lote numa GPU alugada que liga só durante o trabalho, para não esperar semanas pelo Mac nem pelo plano gratuito, pagando centavos por hora de áudio.

## Scope
**In:** local novo `gpu-on-demand` com o adaptador Modal: uma função com o nosso contêiner (faster-whisper large-v3-turbo com os parâmetros da ADR 0023 e pyannote `community-1` ou o motor aprovado no KBC-081), GPU L4 por padrão; o adaptador no `media-worker` da VM manda lotes de trabalhos, recebe o resultado bruto e o lança como os outros locais; o token do Modal colado na tela e cifrado (ADR 0017), "Testar conexão"; estimativa por lote antes de rodar (GPU-segundos × preço gravado + partida), reserva no teto; o contêiner não grava nada em volume e é desligado ao fim; teste de qualidade (WER e DER) como nos KBC-080 e KBC-081.
**Out:** impressões de voz (nunca saem, ADR 0031 §3); outros fornecedores de GPU (RunPod etc., só se o Modal falhar); vídeo.

## Business rules
- BR-1: só roda para acervos que permitem GPU alugada e a etapa (KBC-078); impressões de voz nunca.
- BR-2: cada lote reserva a estimativa antes de ligar a GPU; se não couber nos tetos, o lote é diminuído até caber ou não roda.
- BR-3: a GPU desliga depois de no máximo 5 min sem trabalho; um lote nunca passa de 2 h de GPU (corta e continua noutro).
- BR-4: o contêiner não guarda áudio, transcrição nem vetores depois da resposta; nenhum volume persistente.
- BR-5: só pode ser o primeiro local de uma etapa com o teste de qualidade aprovado (WER ≤ 10 %, DER ≤ 15 %).

## Functional requirements
- FR-1: "Conectar GPU alugada" deve aceitar o token, cifrá-lo e testar a conexão; o token nunca volta à tela nem aos logs.
- FR-2: Quando houver trabalhos para `gpu-on-demand`, o adaptador deve juntá-los em lotes (até 2 h de GPU estimada), reservar, chamar a função e lançar resultado e custo real por trabalho. (BR-2, BR-3)
- FR-3: A imagem do contêiner deve ser construída no CI a partir do repositório, com os modelos de hash conferido; a versão da imagem vai no resultado bruto.
- FR-4: A tela deve mostrar o custo estimado por hora de áudio da GPU e, por lote, o custo real e o tempo.

## Non-functional requirements
- NFR-1: ≤ US$ 0,08 por hora de áudio para transcrição + vozes, medido num lote real de ≥ 5 h e conferido com o painel do Modal (diferença ≤ 5 %).
- NFR-2: 50 h processadas em ≤ 4 h de relógio.
- NFR-3: WER e DER iguais aos limites dos KBC-080 e KBC-081.

## Acceptance criteria
- **AC-1** (FR-2): Given 3 trabalhos de um acervo que permite e `transcribe` = [Computador pareado, GPU alugada] com o Mac parado há N horas, When o despachante roda, Then os 3 vão num lote e voltam transcritos com "Transcrito em GPU alugada".
- **AC-2** (BR-1, negativo): Given um acervo `Só para transcrever`, When há trabalhos `diarize` dele, Then nenhum vai à GPU alugada.
- **AC-3** (BR-2, teto): Given US$ 0,50 sobrando no teto e um lote estimado em US$ 0,80, When o adaptador monta o lote, Then manda só o que cabe e o resto espera com "Teto mensal de mídia atingido".
- **AC-4** (BR-3): Given o lote terminado, When passam 5 min, Then a função não tem contêiner ligado (consultado na API do Modal falsa).
- **AC-5** (FR-1, negativo): Given um token inválido, When "Testar conexão", Then "O token não foi aceito" e o token não aparece em resposta nem log.
- **AC-6** (BR-5): Given a GPU sem teste aprovado, When o master tenta pô-la em primeiro, Then a tela recusa.
- **AC-7** (BR-4): Given o código da função, When o teste de contrato inspeciona a definição, Then não há volume persistente montado.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-3, AC-4 | integração | API do Modal falsa |
| AC-5 | integração | varredura do log pelo token |
| AC-6 | integração + E2E | |
| AC-7 | unitário | |
| NFR-1, NFR-2, NFR-3 | manual, 1 lote real | gasto ≤ US$ 1, dentro do crédito grátis |

## References
ADR: [0031](../adr/0031-processing-location-per-step.md) · Preço: modal.com/pricing (L4 US$ 0,000222/s, crédito de US$ 30/mês no Starter; conferido em 2026-11-03) · Pesquisa: [métodos](../research/2026-11-03-audio-editing-methods.md) (pyannote `community-1` 31 s/h numa GPU de servidor) · Itens: KBC-078, KBC-079, KBC-080, KBC-081

## Open questions
- Usar GPU alugada (Modal, EUA)? Padrão recomendado: sim, só para lotes e acervos que permitem, dentro dos tetos; o dono cria a conta e cola o token (ação humana). — owner: dono
- A GPU alugada conta como "fora da nossa infraestrutura" para a privacidade? Padrão recomendado: sim (é um operador nos EUA), mesmo rodando o nosso contêiner. — owner: dono

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (ADR 0031 proposta)
- [ ] Dependencies done or scheduled; no open questions (conta do Modal: ação do dono)
- [x] Fits one goal
