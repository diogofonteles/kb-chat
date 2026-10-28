---
id: KBC-035
title: "Envio de mídia completo: retomável, vários arquivos, vídeo em 720p, cota por pessoa e arquivo repetido detectado"
status: ready
slice: phase-2-a
outcome: o dono envia uma pasta de palestras pelo navegador sem perder o progresso numa queda de conexão e sem duplicar o acervo
depends_on: [KBC-034]
---

# KBC-035 — Envio retomável, vídeo, cota e arquivos repetidos

## Story
Como pessoa com `media-upload`, quero enviar vários áudios ou vídeos grandes de uma vez, retomando se a conexão cair, para montar o acervo sem recomeçar envios.

## Scope
**In:** envio retomável (protocolo tus, Uppy na tela) com vários arquivos; até 4 GB por arquivo; vídeo (mp4, mov, mkv, webm) convertido para H.264 720p com faststart, além da cópia de áudio; cota de espaço por pessoa; detecção de arquivo repetido por SHA-256; título sugerido pelo nome do arquivo.
**Out:** importação em lote a partir de uma pasta do Mac (fase B); originais guardados (decisão do dono: não guardar).

## Business rules
- BR-1: cada pessoa tem uma cota de espaço convertido, padrão 5 GB, editável por masters na pessoa; o dono não tem cota.
- BR-2: um arquivo com o mesmo SHA-256 de uma mídia já existente no mesmo acervo não é enviado de novo; a pessoa é levada à mídia existente.
- BR-3: um envio interrompido pode ser retomado por 24 h; depois, as partes são apagadas.

## Functional requirements
- FR-1: Quando a pessoa escolhe arquivos, a tela deve calcular o SHA-256 de cada um no navegador e perguntar à API se já existe; se existir, mostrar "Já está no acervo" com o link, sem enviar. (BR-2)
- FR-2: O envio deve usar tus com partes de 8 MB e retomar do último byte confirmado após queda de rede ou recarga da página. (BR-3)
- FR-3: Antes de aceitar, a API deve recusar com `MEDIA_QUOTA_EXCEEDED` o envio que passaria a cota pela estimativa (áudio 30 MB/h; vídeo 400 MB/h). (BR-1)
- FR-4: Para vídeo, o worker deve gerar a cópia 720p e a cópia de áudio; o player ganha só a visão de vídeo da ADR 0025 (área com proporção reservada, pôster, tela cheia com F, picture-in-picture onde houver e a legenda sobre a imagem), sem mudar o `MediaEngine` nem os recursos (velocidade, retomar, marcadores, silêncios, timer, transcrição).
- FR-5: Um job agendado deve apagar partes de envios parados há mais de 24 h. (BR-3)

## Non-functional requirements
- NFR-1: um envio de 1 GB interrompido aos 60 % retoma e termina sem reenviar mais de 8 MB do já enviado.
- NFR-2: a conversão de 1 h de vídeo para 720p roda dentro do limite do worker (1 CPU) sem derrubar o site (mesma medida do KBC-034 NFR-1); duração aceitável ≤ 1,5 h por hora de vídeo.

## Acceptance criteria
- **AC-1** (FR-2): Given um envio de 200 MB em andamento, When a rede cai aos 50 % e volta, Then o envio continua de onde parou e a mídia é criada uma vez só.
- **AC-2** (FR-1, BR-2): Given um áudio já no acervo, When a pessoa escolhe o mesmo arquivo, Then vê "Já está no acervo: <título>" com o link e nada é enviado.
- **AC-3** (FR-3, BR-1): Given uma pessoa com 4,9 GB usados de 5 GB, When escolhe um áudio de 10 h, Then vê "Este envio passa da sua cota de 5 GB. Fale com um master para aumentar." e nada é enviado.
- **AC-4** (BR-1): Given o dono, When envia qualquer volume, Then nenhuma cota é aplicada.
- **AC-5** (FR-4): Given um vídeo mp4 de 2 min, When termina a conversão, Then ele toca como vídeo em 720p e a cópia de áudio existe para a transcrição.
- **AC-6** (BR-3, FR-5): Given um envio parado há 25 h, When o job de limpeza roda, Then as partes somem e a retomada mostra "Este envio expirou. Envie de novo."
- **AC-7** (limite): Given um arquivo de 4,1 GB, When é escolhido, Then a tela recusa antes de enviar.
- **AC-8**: envio de 3 arquivos ao mesmo tempo em 1440 px e 390 px, com progresso por arquivo anunciado a leitores de tela, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 | E2E | Interrupção simulada abortando a requisição de uma parte |
| AC-2, AC-3, AC-4, AC-7 | integração + componente | |
| AC-5 | integração | Vídeo de teste gerado por ffmpeg |
| AC-6 | unitário | Relógio falso |
| AC-8 | E2E | axe |

## References
ADR: [0022](../adr/0022-media-library-store-queue-and-streaming.md) · Plano da fase 2 v3 (A2) · tus: protocolo 1.0 · Uppy

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled (KBC-034); no open questions
- [x] Fits one goal
