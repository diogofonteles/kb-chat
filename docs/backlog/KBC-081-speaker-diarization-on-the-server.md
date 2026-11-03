---
id: KBC-081
title: "Separar as vozes sem o Mac: diarização no servidor (VM, CPU, ONNX), sem o áudio sair, com a mesma saída do KBC-064 e o mesmo limite de erro"
status: draft
slice: phase-3-server-processing
outcome: com o Mac desligado, as vozes de uma palestra de 1 h ficam separadas em ≤ 1 h na VM, com erro de diarização ≤ 15 % nas gravações de teste, sem custo e sem o site ficar lento
depends_on: [KBC-079, KBC-064]
---

# KBC-081 — Separar as vozes no servidor

## Story
Como quem edita gravações, quero que a separação de vozes rode no servidor quando o Mac do dono não está ligado, sem mandar o áudio para fora, para editar as faixas no mesmo dia.

## Scope
**In:** trabalho `diarize` feito pelo `media-worker` da VM (limite de 1 CPU e 2 GB, ADR 0022) com um motor ONNX em CPU (sherpa-onnx: segmentação pyannote 3.0 + vetores CAM++/3D-Speaker, int8, licenças Apache/MIT), modelos baixados na construção da imagem com hash conferido; a mesma saída do KBC-064 (turnos brutos, versão do modelo e dos parâmetros), nenhuma impressão de voz guardada; "Servidor" passa a ser local permitido de `diarize` em "Processamento" (KBC-079); medida de DER nas gravações de teste do KBC-063 e de tempo de máquina na VM; o teste de qualidade como no KBC-080 (só pode ser o primeiro local se DER ≤ 15 %).
**Out:** reconhecer quem fala (KBC-082); GPU alugada e provedor para vozes (KBC-085, KBC-078); mudar o modelo do Mac.

## Business rules
- BR-1: o áudio não sai da VM; o trabalho usa o FLAC 16 kHz já produzido para a transcrição ou o produz e apaga ao fim.
- BR-2: o servidor só pode ser o primeiro local de `diarize` com o teste de qualidade aprovado (DER ≤ 15 % nas 2 gravações de teste do KBC-063); senão fica só como reserva.
- BR-3: o trabalho roda com prioridade baixa (`nice`) e nunca com mais de 1 CPU; conversões (`transcode`) passam na frente.
- BR-4: as regras do KBC-064 valem iguais (versão nova a cada refazer, 1 a 10 vozes, "número de vozes" opcional, nenhum embedding guardado).

## Functional requirements
- FR-1: O `media-worker` deve reservar `diarize` quando o despachante permitir o servidor, rodar o motor ONNX com o número de vozes quando informado e enviar os turnos brutos com `engine`, `model` e `params`. (BR-1, BR-4)
- FR-2: A imagem do worker deve trazer os modelos com hash SHA-256 conferido na construção; hash diferente falha o build.
- FR-3: "Testar qualidade" de `diarize` (master) deve rodar as 2 gravações de teste com a marcação do dono e gravar DER e tempo por hora de áudio. (BR-2)
- FR-4: Ao terminar, o worker deve apagar o FLAC e qualquer arquivo temporário de vetores. (BR-1, BR-4)
- FR-5: A página do áudio deve mostrar "Vozes separadas no servidor" e o tempo que levou.

## Non-functional requirements
- NFR-1: DER ≤ 15 % nas 2 gravações de teste (mesma meta do KBC-064), medido com o script do KBC-063.
- NFR-2: ≤ 60 min de máquina por hora de áudio no `media-worker` (1 CPU Ampere); a medir na primeira rodada e gravado no item.
- NFR-3: durante a separação, o site responde HTTP 200 com p95 ≤ 1 s em 60 checagens (como o piloto da VM).
- NFR-4: a imagem do worker cresce ≤ 600 MB.

## Acceptance criteria
- **AC-1** (FR-1): Given `diarize` = [Computador pareado, Servidor] com N = 2 h e o Mac desligado, When passam 2 h, Then a VM separa as vozes e a transcrição mostra "Voz 1", "Voz 2"… como no KBC-064.
- **AC-2** (BR-1, FR-4): Given o trabalho concluído, When o teste lista o diretório temporário e o banco, Then não há FLAC nem arquivos de vetores e nenhum pedido de rede saiu do worker além da API.
- **AC-3** (BR-2, FR-3, negativo): Given o teste de qualidade com DER 18 %, When o master tenta pôr "Servidor" em primeiro, Then a tela recusa com o DER medido.
- **AC-4** (BR-3, NFR-3): Given uma separação de 1 h rodando, When o teste de carga faz 60 checagens, Then todas dão 200 e o p95 ≤ 1 s.
- **AC-5** (BR-4, limite): Given "número de vozes: 2", When separada uma conversa a dois, Then o resultado tem exatamente 2 vozes.
- **AC-6** (FR-2, negativo): Given um modelo com hash diferente, When a imagem é construída, Then o build falha.
- **AC-7** (FR-1): Given o worker morto no meio, When a reserva vence, Then o trabalho volta à fila e termina uma vez só.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-5, AC-7 | integração (worker com motor falso) + 1 rodada real na VM de staging (Mac) | |
| AC-2 | integração | rede do contêiner de teste sem saída |
| AC-3 | integração + E2E | |
| AC-4, NFR-2, NFR-3 | manual na VM | script de checagens do piloto |
| AC-6 | CI (build da imagem) | |
| NFR-1 | manual | marcação do dono (KBC-063 §10.1) |

## References
ADR: [0031](../adr/0031-processing-location-per-step.md), [0022](../adr/0022-media-library-store-queue-and-streaming.md) (§3), [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) (§1) · Pesquisa: [métodos](../research/2026-11-03-audio-editing-methods.md) (frente 1, sherpa-onnx), [teste de oradores](../research/2026-11-03-audio-editing-test-speakers.md) · Itens: KBC-063, KBC-064, KBC-079

## Open questions
- Separar vozes no servidor é o padrão sem o Mac (grátis, lento) ou a GPU alugada (rápida, centavos, áudio sai)? Padrão recomendado: servidor por padrão; GPU alugada só para lotes grandes e acervos que permitem (KBC-085). — owner: dono
- Se o motor ONNX não passar de DER 15 %, o que vale? Padrão recomendado: o servidor fica só como reserva com o aviso "qualidade menor" e a GPU alugada vira a opção sem o Mac. — owner: dono

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (ADR 0031 proposta)
- [ ] Dependencies done or scheduled; no open questions
- [x] Fits one goal
