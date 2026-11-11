---
id: KBC-082
title: "Reconhecer quem fala sem o Mac: perfis de voz e comparação no servidor (ECAPA em CPU sobre trechos amostrados de cada voz), impressões que nunca saem da nossa infraestrutura"
status: draft
slice: phase-3-server-processing
outcome: com o Mac desligado, as sugestões de quem fala por voz (KBC-071) chegam em ≤ 5 min de máquina por gravação de 1 h na VM, com o mesmo acerto do Mac e nenhuma impressão de voz fora da VM e dos computadores pareados
depends_on: [KBC-071, KBC-081]
---

# KBC-082 — Reconhecer quem fala no servidor

## Story
Como quem edita gravações de um acervo com perfis de voz consentidos, quero que a sugestão de quem fala apareça mesmo sem o Mac do dono, sem que as impressões de voz saiam do nosso servidor.

## Scope
**In:** trabalhos `voice-profile` (criar o perfil) e a comparação de vozes depois do `diarize` feitos pelo `media-worker` da VM; vetor ECAPA (SpeechBrain, Apache-2.0) só sobre trechos amostrados de cada voz (até 60 s de fala por voz, os segmentos mais longos), em CPU; exportação ONNX do ECAPA se der o mesmo vetor (cosseno ≥ 0,999 com o PyTorch), senão uma imagem Python separada `voice-worker` com o mesmo limite de CPU; mesma regra de decisão do KBC-071 (limiar, margem para o segundo perfil, grupo ≥ 10 s); "Servidor" como local de `voice-embedding` (KBC-079); perfis guardados cifrados (ADR 0017) e entregues ao worker só durante o trabalho.
**Out:** provedor ou GPU alugada para impressões (proibido, ADR 0031 §3); calibrar o limiar (KBC-071); perfis entre acervos.

## Business rules
- BR-1: impressões de voz só são calculadas, comparadas e guardadas na VM ou num computador pareado autorizado no acervo; nunca saem para provedor, GPU alugada ou navegador.
- BR-2: valem todas as regras do KBC-071 (consentimento antes, revogar apaga em ≤ 1 min, sugestão só acima do limiar, perfil só no acervo).
- BR-3: o vetor da VM tem de ser o mesmo do Mac para o mesmo trecho (cosseno ≥ 0,999); senão os perfis feitos num lugar não valem no outro e o perfil guarda o motor com que foi feito.
- BR-4: os trechos amostrados e os vetores das vozes da gravação são apagados ao fim do trabalho; só o perfil consentido fica.

## Functional requirements
- FR-1: O worker da VM deve reservar `voice-profile` e a comparação quando o despachante permitir o servidor, calcular os vetores só dos trechos amostrados e devolver o perfil (cifrado na API) ou o perfil mais próximo e a semelhança por voz. (BR-1, BR-2)
- FR-2: O despachante deve recusar qualquer local que não seja servidor ou computador pareado para `voice-embedding`, mesmo com acervo `Para transcrever e separar vozes`. (BR-1)
- FR-3: Cada perfil deve guardar `engine` e `model`; comparar uma voz com um perfil de motor diferente só é permitido se o teste de equivalência do BR-3 passou. (BR-3)
- FR-4: Ao terminar, o worker deve apagar os trechos e os vetores temporários. (BR-4)

## Non-functional requirements
- NFR-1: ≤ 5 min de CPU na VM por gravação de 1 h com até 6 vozes.
- NFR-2: as decisões do teste de oradores do KBC-063 (José Luiz e Monteiro) saem iguais às do Mac (2 reconhecidos, 0 falso positivo).
- NFR-3: cosseno ≥ 0,999 entre o vetor da VM e o do Mac para os mesmos 20 trechos.

## Acceptance criteria
- **AC-1** (FR-1): Given um perfil consentido do Mestre José Luiz e o Mac desligado, When a entrevista de teste é separada no servidor, Then a voz de quem responde vem sugerida como "Mestre José Luiz" e a do entrevistador fica sem sugestão.
- **AC-2** (BR-1, FR-2, negativo): Given um acervo `Para transcrever e separar vozes` e `voice-embedding` com um provedor injetado no banco, When o despachante roda, Then o trabalho não vai ao provedor e o erro é registrado.
- **AC-3** (BR-4, FR-4): Given a comparação concluída, When o teste lista arquivos e tabelas, Then só existe o perfil consentido; nenhum vetor das vozes da gravação.
- **AC-4** (BR-3, FR-3): Given um perfil feito no Mac, When comparado no servidor sem o teste de equivalência aprovado, Then a sugestão não aparece e a tela diz "Perfil feito em outro motor; refaça o perfil".
- **AC-5** (BR-2): Given o consentimento revogado, When passa 1 minuto, Then o perfil sumiu da VM e nenhuma sugestão nova aparece.
- **AC-6** (NFR-1): Given uma gravação de 1 h com 4 vozes, When comparada na VM, Then o tempo de máquina gravado é ≤ 5 min.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, NFR-2 | manual na VM de staging + integração com vetores de fixture | |
| AC-2 | unitário (despachante) + integração | |
| AC-3, AC-5 | integração | |
| AC-4, NFR-3 | integração (pytest/vitest com 20 trechos) | |
| AC-6, NFR-1 | manual | |

## References
ADR: [0031](../adr/0031-processing-location-per-step.md) (§3), [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) (§3), [0017](../adr/0017-secrets-sealed-at-rest.md) · Pesquisa: [teste de oradores](../research/2026-11-03-audio-editing-test-speakers.md) (ECAPA em CPU 1.411 s por hora de áudio sem amostragem; 11–14 s no MPS) · Itens: KBC-071, KBC-081

## Open questions
- Confirmar que impressões de voz nunca saem da nossa infraestrutura, mesmo com o acervo permitindo vozes na nuvem. Padrão recomendado: nunca. — owner: dono

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked (ADR 0031 proposta)
- [ ] Dependencies done or scheduled; no open questions
- [x] Fits one goal
