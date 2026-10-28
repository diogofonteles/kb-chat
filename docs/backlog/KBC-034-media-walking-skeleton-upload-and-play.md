---
id: KBC-034
title: "Mídia (esqueleto): enviar um áudio, o aplicativo converte numa fila confiável e a pessoa ouve no navegador"
status: ready
slice: phase-2-a
outcome: o primeiro áudio do acervo toca no navegador a partir do servidor, com a base (banco, fila, processador de mídia) que as fases seguintes usam
depends_on: [KBC-010, KBC-012]
---

# KBC-034 — Mídia (esqueleto): enviar, converter e ouvir

## Story
Como master, quero enviar um áudio de palestra e ouvi-lo no navegador, para começar o acervo de mídia sem depender do terminal.

## Scope
**In:** banco SQLite do módulo `media` com migrações; fila confiável (reserva com prazo, sinal de vida, recuperação, limite de tentativas, lista de falhas); contêiner `media-worker` com 1 CPU e 2 GB; envio simples (um arquivo por vez, até 500 MB); conversão para AAC 64k mono `.m4a` com faststart; lista "Mídia" por acervo (T14), com remoção por masters; o player próprio do app com os controles básicos (T15: tocar/pausar, voltar 15 s, avançar 30 s, barra de progresso com o trecho carregado, tempos, estados de carregamento e erro); entrega com Range; liga/desliga `KB_CHAT_MEDIA`; nova permissão `media-upload`; backup do banco.
**Out:** velocidade, volume, atalhos de teclado, controles do sistema, retomar e mini-player (KBC-041); transcrição (KBC-036), legendas e transcrição clicável (KBC-038), busca (KBC-039), envio retomável, cotas, vídeo e arquivo repetido (KBC-035).

## Business rules
- BR-1: só envia mídia quem tem a permissão `media-upload` (masters têm todas). Convites e perfis não a concedem por padrão.
- BR-2: quem vê os documentos de um acervo vê e ouve a mídia desse acervo; quem não vê recebe 404, como nos documentos (ADR 0008).
- BR-3: toda mídia pertence a um acervo e tem autoria (`mestre-laercio` ou `outros-autores`, ADR 0015), escolhidos no envio.
- BR-4: o original enviado não é guardado; só a cópia convertida (decisão do dono, 2026-10-28).
- BR-5: um trabalho que falha por erro temporário volta à fila até 3 vezes; depois fica em "Falhou" com o motivo. Um arquivo inválido falha na hora, sem nova tentativa.

## Functional requirements
- FR-1: Quando `KB_CHAT_MEDIA=on`, a API deve abrir `/data/media/media.db`, aplicar as migrações pendentes e recusar a subida se o diretório não for gravável ou uma migração falhar (ADR 0022). Com `off`, nenhuma rota de mídia existe.
- FR-2: Quando uma pessoa com `media-upload` envia um arquivo de áudio (mp3, m4a, wav, flac, ogg, opus) de até 500 MB com título, acervo e autoria, o sistema deve gravá-lo, criar a mídia com status "Na fila" e um trabalho `transcode`. (BR-1, BR-3)
- FR-3: O `media-worker` deve reservar um trabalho por vez, mandar sinal de vida a cada 15 s, converter com ffmpeg (caminho absoluto, tempo limite), medir a duração com ffprobe e concluir; a mídia passa a "Pronta" e o arquivo enviado é apagado. (BR-4)
- FR-4: Quando a reserva de um trabalho vence sem sinal de vida, a API deve devolvê-lo à fila; na 4ª vez, marcá-lo como "Falhou". (BR-5)
- FR-5: `GET /api/v1/topics/{topic}/media` deve listar as mídias do acervo (título, autoria, duração, status) e `GET /api/v1/media/{id}/stream` deve entregar o áudio com Range (206, `Accept-Ranges: bytes`, `Content-Range`, `ETag`, `If-Range`, 416 fora do arquivo, `Content-Type: audio/mp4`), sem ler o arquivo inteiro. (BR-2)
- FR-6: A tela "Mídia" deve mostrar a lista do acervo selecionado, o status de cada item, o player do item aberto e, para quem tem `media-upload`, o botão "Enviar áudio", como em `docs/design/screens.md` T14 e T15.
- FR-6a: O player deve ser um componente próprio sobre um elemento de mídia sem `controls`, em camadas que não sabem se a mídia é áudio ou vídeo (ADR 0025: um `MediaEngine` único no app, recursos por cima, visões por cima dos recursos), com tocar/pausar, voltar 15 s, avançar 30 s e barra de progresso (`role="slider"`, setas 5 s, PageUp/PageDown 60 s, Home/End), sem passar de 0 nem do fim, e com os estados "carregando", "esperando dados" (após 300 ms seguidos, nunca durante um pulo pedido), "erro com Tentar de novo no mesmo segundo" e "terminou". O estado vem dos eventos do elemento (`playing`, `pause`, `waiting`, `ended`, `error`), nunca da chamada `play()`, cuja promessa recusada é tratada; uma carga antiga que termina depois de uma nova é descartada; limpar a fonte é `removeAttribute('src')` + `load()`. Um clique na trilha pula sem arrastar; o `aria-valuetext` fala o tempo e diz a duração só ao focar.
- FR-7: Masters devem ver os trabalhos em "Falhou" com o motivo e poder "Tentar de novo".
- FR-8: Quando um master confirma "Remover" numa mídia, o sistema deve apagar o registro, o arquivo convertido e os trabalhos pendentes dela; uma reprodução em andamento por outra pessoa passa a receber 404.

## Non-functional requirements
- NFR-1: com uma conversão rodando, a busca do site segue respondendo HTTP 200 com p95 ≤ 1,5 s (medido como no piloto: 30 checagens durante a conversão de 1 h de áudio).
- NFR-2: 1 h de áudio convertida em ≤ 90 s na VM (piloto: 45–54 s).
- NFR-3: o player começa a tocar em ≤ 2 s e pular para o meio de um áudio de 1 h leva ≤ 2 s (rede de casa).

## Acceptance criteria
- **AC-1** (FR-2, FR-3): Given um master no acervo "hermetismo", When envia um mp3 de 3 min com título e autoria, Then o item aparece "Na fila", depois "Convertendo" e "Pronto", com a duração certa, e toca no player.
- **AC-2** (FR-5): Given uma mídia pronta de 1 h, When o player pula para 45:00, Then a requisição recebe 206 com o `Content-Range` pedido e o áudio toca dali.
- **AC-3** (BR-2): Given uma pessoa sem acesso ao acervo, When pede a lista ou o stream de uma mídia dele, Then recebe 404.
- **AC-4** (BR-1): Given uma pessoa com `search` mas sem `media-upload`, When abre "Mídia", Then não vê "Enviar áudio", e `POST` de envio responde 403.
- **AC-5** (FR-4, BR-5): Given um trabalho reservado cujo worker parou, When a reserva vence, Then ele volta à fila; após a 3ª nova tentativa, fica "Falhou" com o motivo e o master pode "Tentar de novo".
- **AC-6** (BR-5): Given um arquivo .mp3 corrompido, When é enviado, Then a mídia fica "Falhou: o arquivo não é um áudio válido" sem novas tentativas.
- **AC-7** (FR-1): Given `KB_CHAT_MEDIA=on` e `/data/media` somente leitura, When a API sobe, Then ela para com uma mensagem clara no log.
- **AC-8** (limite): Given um arquivo de 501 MB ou um .pdf, When é enviado, Then a API recusa com `VALIDATION_FAILED` e a tela diz "Envie um áudio de até 500 MB (mp3, m4a, wav, flac, ogg ou opus)."
- **AC-9**: fluxo de envio e reprodução em 1440 px e 390 px, nos três temas, sem violações sérias ou críticas do axe.
- **AC-10** (FR-6a): Given uma mídia pronta de 10 s tocando, When a pessoa usa "Avançar 30 segundos", Then a posição vai para o fim, o estado é "terminou" e aparece "Ouvir de novo"; When usa "Voltar 15 segundos" em 0:05, Then vai para 0:00.
- **AC-11** (FR-6a): Given o player com foco na barra de progresso, When a pessoa aperta → três vezes e End, Then a posição avança 15 s e depois vai ao fim, e o `aria-valuetext` diz o tempo em palavras.
- **AC-12** (FR-6a): Given o áudio tocando, When a rede cai e volta, Then o player mostra "Não consegui carregar o áudio. Verifique a conexão." e "Tentar de novo" retoma do mesmo segundo (±1 s).
- **AC-14** (FR-6a, ADR 0025): Given a suíte de contrato do `MediaEngine`, When roda contra um `<audio>` e contra um `<video>`, Then os dois passam igual (tocar, pausar, pular, espera, erro, fim, carga antiga descartada).
- **AC-13** (FR-8): Given uma mídia pronta, When um master confirma "Remover", Then ela some da lista, o arquivo convertido não existe mais e o stream responde 404; When cancela, Then nada muda. Quem não é master não vê "Remover" e o `DELETE` responde 403.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 | E2E + integração | Áudio de 10 s gerado por ffmpeg no teste; worker real no E2E |
| AC-2 | integração + propriedades (fast-check) | Range: início, meio, sufixo, aberto, múltiplo (responde o primeiro ou 200), `If-Range` com ETag velho (200) e 416 |
| AC-3, AC-4 | integração | Contas de teste do E2E |
| AC-5, AC-6 | unitário (fila) + integração | Relógio falso para o vencimento |
| AC-7 | integração | Diretório sem permissão |
| AC-8 | integração + componente | |
| AC-9 | E2E | 1440 e 390 px, três temas, axe |
| AC-10, AC-11 | unitário (máquina de estados do player com elemento de mídia falso) + componente + E2E | O E2E confere que o áudio toca de verdade (`currentTime` avança) |
| AC-12 | unitário + E2E | Rede cortada pelo Playwright (`route.abort`) no meio da reprodução |
| AC-13 | integração + E2E | Confere o arquivo no disco |
| AC-14 | unitário (suíte de contrato) + E2E | Elemento de mídia falso no unitário; `<audio>` e `<video>` reais no E2E |

## References
ADR: [0022](../adr/0022-media-library-store-queue-and-streaming.md) · Plano da fase 2 v3 (itens A1, A3) · Piloto: [`docs/research/2026-10-28-transcription-pilot.md`](../research/2026-10-28-transcription-pilot.md) · Telas: `docs/design/screens.md` T14 (Mídia) e T15 (Player) · Player: [ADR 0025](../adr/0025-own-media-player-for-audio-and-video.md) · Barra de qualidade da fase 2: `docs/backlog/README.md`

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies done; no open questions
- [x] Fits one goal
