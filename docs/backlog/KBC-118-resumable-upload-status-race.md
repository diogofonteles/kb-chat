---
id: KBC-118
title: "Dois pedidos de status do envio retomável ao mesmo tempo nunca devolvem offset 0 para um arquivo inteiro"
status: in-progress
slice: phase-2-a
outcome: o status (tus HEAD) de um envio retomável cujo arquivo inteiro já está guardado responde sempre o tamanho todo, mesmo com pedidos simultâneos; meta 0 falhas do teste "finishes an upload whose whole file is kept but never ended, once" em 50 execuções seguidas e um teste determinístico da corrida
depends_on: [KBC-035]
---

# KBC-118 — Corrida no status do envio retomável devolve offset 0

Origem: fila do dono em `work/HANDOFF-2026-11-10.md` (checkout principal): o teste `media-upload.integration.test.ts`, "finishes an upload whose whole file is kept but never ended, once", falhou uma vez com `upload-offset` 0 em vez de 38. Provável corrida no `uploadStatus` entre dois pedidos de status simultâneos. Reproduzir com teste determinístico (ADR 0033).

## Story
Como quem envia um áudio grande e volta depois de uma queda, quero que o app reconheça que o arquivo já chegou inteiro, para não ver um erro nem mandar tudo de novo.

## Contexto (o que existe hoje)
- O núcleo tus fica no próprio item (ADR 0033, KBC-035 FR-2): `HEAD /api/v1/media/:id/upload` chama `MediaService.uploadStatus`, que lê o registro (`status`), depois o tamanho do `.part` no disco (`uploadOffset`, um `stat`).
- Um arquivo inteiro guardado e nunca terminado (a API caiu entre o último byte e o fim) é terminado pelo primeiro HEAD que o encontra: confere o hash, renomeia `.part` → arquivo final (`finishUpload`) e põe na fila (`markUploaded`).
- Um segundo HEAD simultâneo leu o registro ainda como `uploading`; se o seu `stat` acontece depois do `rename` do primeiro, não acha o `.part` e responde `upload-offset: 0`. O cliente tus então tenta mandar tudo de novo a partir do 0 e recebe 409, porque o item já está na fila.

## Scope
**In:** a resposta do `uploadStatus` quando um término acontece enquanto o tamanho é lido; o término que acha o `.part` já apagado (cancelado ou recomeçado por outro pedido); um teste determinístico de cada intercalação.
**Out:** mudar o protocolo tus, o cliente web, o PATCH, o envio sem retomada (`PUT /file`) ou o zelador de envios abandonados.

## Business rules
- BR-1: um HEAD nunca responde um offset menor que o tamanho quando o arquivo inteiro já foi aceito (terminado ou terminando); responde o tamanho todo.
- BR-2: um arquivo inteiro com hash diferente do anunciado continua recomeçando do 0 (KBC-035 AC-1), para todos os pedidos.
- BR-3: um HEAD durante um PATCH parcial continua respondendo o que já chegou, sem esperar o PATCH.
- BR-4: um término que acha o `.part` apagado responde "recomeçar do 0" se o item continua lá, e "não existe" (404) se o envio foi cancelado; nunca um erro 500.

## Functional requirements
- FR-1: `uploadStatus` deve, depois de ler o tamanho, esperar um término em andamento desse item ou reler o registro, e responder pelo estado depois dele. (BR-1, BR-2)
- FR-2: o término deve traduzir a falta do `.part` (`ENOENT`) em recomeço, ou em `MEDIA_NOT_FOUND` quando o item foi removido. (BR-4)

## Non-functional requirements
- NFR-1: o teste original passa 50 vezes seguidas; o teste da corrida não usa espera por tempo nem repetição.

## Acceptance criteria
- **AC-1** (BR-1, FR-1): Given um arquivo inteiro guardado e nunca terminado, When dois HEAD chegam juntos e o `stat` do segundo acontece entre o `rename` do primeiro e a sua entrada na fila (o segundo vê 0 com o item ainda `uploading`), Then os dois respondem `upload-offset` igual ao tamanho, o item fica `queued` uma vez e há um só trabalho na fila.
- **AC-2** (BR-1, borda): Given o mesmo cenário em que o primeiro HEAD termina por completo antes de o `stat` do segundo voltar, Then o segundo responde o tamanho.
- **AC-3** (BR-2, negativo): Given um arquivo inteiro com bytes diferentes do anunciado e dois HEAD juntos, Then os dois respondem 0 e o item continua `uploading`.
- **AC-4** (BR-3): Given um PATCH parcial em andamento, When chega um HEAD, Then ele responde o offset de agora sem esperar o PATCH acabar.
- **AC-5** (NFR-1): o teste "finishes an upload whose whole file is kept but never ended, once" passa em 50 execuções seguidas.
- **AC-6** (BR-4, FR-2): Given bytes diferentes do anunciado e um segundo HEAD que leu o `.part` inteiro antes de o primeiro o apagar, mas só continua depois de o primeiro responder, Then o segundo responde 0 (não 500) e o item continua `uploading`.
- **AC-7** (BR-4, FR-2): Given um HEAD conferindo o hash do arquivo inteiro, When o envio é cancelado (removido) no meio, Then esse HEAD responde `MEDIA_NOT_FOUND` (não 500 `ENOENT`).

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 a AC-4, AC-6, AC-7 | unitário/serviço | `apps/api/src/media-upload-status.test.ts`: `MediaService` real com SQLite e `FsMediaFiles` real, porta de arquivos envolvida com barreiras (sem `sleep`) |
| AC-5 | integração API | `media-upload.integration.test.ts` repetido 50x |

## References
ADR: [0033](../adr/0033-resumable-uploads-tus-core-on-the-item.md) · Código: `apps/api/src/modules/media/media-service.ts` (`uploadStatus`, `finish`, `hold`), `apps/api/src/adapters/media/fs-media-files.ts` (`uploadOffset`, `finishUpload`), `apps/web/src/app/core/media/tus-upload.ts` · Item: KBC-035 FR-2, AC-1.
