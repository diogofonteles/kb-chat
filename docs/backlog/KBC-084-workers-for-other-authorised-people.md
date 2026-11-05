---
id: KBC-084
title: "Outras pessoas autorizadas pareiam o próprio computador (macOS, Windows, Linux): transcritor empacotado com mlx-whisper ou faster-whisper, restrito aos acervos dela"
status: draft
slice: phase-3-server-processing
outcome: o processamento deixa de depender de uma pessoa: ≥ 2 computadores de pessoas diferentes processam trabalhos dos seus acervos, com qualidade igual à do Mac do dono (WER ≤ 10 % nos trechos limpos) e sem custo
depends_on: [KBC-079, KBC-036, KBC-064]
---

# KBC-084 — Computadores de outras pessoas autorizadas

## Story
Como pessoa autorizada que envia gravações de um acervo, quero ligar o meu próprio computador como transcritor, para processar os meus envios sem depender do Mac do dono e sem custo.

## Scope
**In:** permissão nova `media-worker-pair` ("Ligar o meu computador como transcritor"), dada por um master por pessoa; a tela "Transcritores" (KBC-036) aberta a quem tem a permissão, mostrando só os computadores dela (masters veem todos); pareamento igual ao da ADR 0023 (token mostrado uma vez, guardado como hash); o worker reserva só trabalhos de acervos que a pessoa acessa **e** que permitem "computadores de outras pessoas" (novo campo na edição do acervo, padrão sim para quem já acessa); pacotes: macOS Apple Silicon (mlx-whisper, como hoje), Windows e Linux com NVIDIA (faster-whisper/CTranslate2, CUDA) e Windows/Linux só CPU (faster-whisper int8, marcado "lento"), todos com os mesmos parâmetros (VAD, cortes ≤ 28 s, termos, temperaturas) e o motor informado no resultado; instalação de um comando por sistema (`uv` + script; serviço `launchd`, `systemd --user` ou Agendador de Tarefas); o teste de qualidade (KBC-080 FR-2) roda num computador pareado e grava o resultado por motor; `diarize` só onde o motor existe (Senko no Mac; sherpa-onnx nos outros).
**Out:** instalador gráfico assinado (fica para depois se pedirem); perfis de voz em computadores de pessoas sem `media-voice-profiles`; pagar pessoas pelo processamento.

## Business rules
- BR-1: só quem tem `media-worker-pair` pareia; a pessoa só vê e revoga os próprios computadores; masters veem e revogam todos.
- BR-2: um computador só reserva trabalhos de acervos que o dono do computador acessa e que permitem computadores de outras pessoas; perder o acesso ao acervo corta na próxima reserva.
- BR-3: impressões de voz de um acervo só vão a um computador cujo dono tem `media-voice-profiles`, permissão que vem do papel master e não é por acervo (BR-5 do KBC-071 vale igual).
- BR-4: um motor só pode ser usado como primeiro local se passou no teste de qualidade (WER ≤ 10 % nos trechos limpos; DER ≤ 15 % para vozes) — o resultado vale por motor e versão, não por computador.
- BR-5: o computador recebe só o FLAC do trabalho que reservou (ADR 0023 §2) e o apaga ao terminar.

## Functional requirements
- FR-1: `POST /api/v1/media-workers` deve aceitar quem tem `media-worker-pair` e criar um worker ligado à pessoa, com os tipos de trabalho escolhidos; sem a permissão, 403. (BR-1)
- FR-2: A reserva deve filtrar trabalhos pelo acesso do dono do worker e pela marcação do acervo, conferidos a cada reserva. (BR-2, BR-3)
- FR-3: O worker deve informar `engine` (`mlx-whisper`, `faster-whisper-cuda`, `faster-whisper-cpu`, `senko`, `sherpa-onnx`), versão e sistema ao parear e em cada resultado. (BR-4)
- FR-4: Os pacotes devem ter um comando de instalação por sistema, documentado na tela "Transcritores", e testes de fumaça em CI para Linux e macOS (Windows em execução manual registrada).
- FR-5: A tela deve mostrar, para cada computador, motor, visto por último, trabalho atual e trabalhos feitos no mês.

## Non-functional requirements
- NFR-1: WER ≤ 10 % nos trechos limpos do piloto com faster-whisper large-v3-turbo em CUDA e em CPU (mesmos parâmetros).
- NFR-2: tempo por hora de áudio medido e mostrado por motor: CUDA (≤ 10 min esperado), CPU (medido, sem meta).
- NFR-3: instalar e parear em ≤ 10 min seguindo só a tela, conferido por uma pessoa que não é o dono.

## Acceptance criteria
- **AC-1** (FR-1, BR-1): Given uma pessoa com `media-worker-pair`, When pareia o computador, Then vê o token uma vez e o computador aparece só na lista dela e na dos masters.
- **AC-2** (BR-1, negativo): Given uma pessoa sem a permissão, When abre "Transcritores", Then não vê a tela e o `POST` responde 403.
- **AC-3** (BR-2, FR-2): Given um computador de quem acessa só o acervo A, When há trabalhos de A e de B na fila, Then ele reserva só os de A.
- **AC-4** (BR-2, negativo): Given o acervo A marcado "Não permite computadores de outras pessoas", When o computador pede trabalho, Then não recebe nenhum de A.
- **AC-5** (BR-2, limite): Given o acesso da pessoa a A retirado, When o computador pede o próximo trabalho, Then não recebe nada de A; o que já estava reservado termina e é aceito.
- **AC-6** (BR-3): Given um trabalho `diarize` com perfis do acervo e o dono do computador sem `media-voice-profiles` (não é master; a permissão não é por acervo), When ele reserva, Then o trabalho vai sem perfis e a sugestão por voz fica para o servidor (KBC-082).
- **AC-7** (FR-3, BR-4): Given um resultado de `faster-whisper-cpu` sem teste aprovado, When o master tenta pôr "Computador pareado (CPU)" em primeiro, Then a tela recusa.
- **AC-8** (BR-5): Given o trabalho concluído num Linux, When o teste lista o diretório de trabalho, Then o FLAC não está lá.
- **AC-9**: tela "Transcritores" para quem não é master em 1440 px e 390 px, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-2, AC-9 | integração + E2E | duas contas |
| AC-3, AC-4, AC-5, AC-6 | integração | worker falso com tokens de pessoas diferentes |
| AC-7 | integração | |
| AC-8 | pytest no pacote | CI Linux e macOS |
| NFR-1, NFR-2 | manual | um PC com NVIDIA e um só CPU; trechos do piloto fora do git |
| NFR-3 | manual | uma pessoa autorizada que não é o dono |

## References
ADR: [0031](../adr/0031-processing-location-per-step.md) (§6), [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) (§1 a §3) · Itens: KBC-036, KBC-064, KBC-071, KBC-079, KBC-080 · Tela: "Transcritores" (KBC-036)

## Open questions
- Quem pode parear um computador? Padrão recomendado: só quem recebe `media-worker-pair` de um master, pessoa por pessoa. — owner: dono
- O áudio de um acervo pode ir para o computador de outra pessoa que já acessa o acervo? Padrão recomendado: sim por padrão (ela já pode ouvir), com a opção de o acervo proibir. — owner: dono
- Precisa de uma pessoa com Windows e NVIDIA para o teste manual. — owner: dono indica quem

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (ADR 0031 proposta)
- [ ] Dependencies done or scheduled; no open questions
- [ ] Fits one goal (se o pacote Windows pesar, dividir em "macOS e Linux" e "Windows")
