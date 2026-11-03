---
id: KBC-064
title: "Separar as vozes de uma gravação no Mac do dono: \"Voz 1\", \"Voz 2\"… na transcrição, sem guardar impressão de voz"
status: ready
slice: phase-2-editing
outcome: quem edita vê, em cada trecho da transcrição, qual voz está falando, com erro de diarização ≤ 15 % nas gravações de teste do KBC-063
depends_on: [KBC-063, KBC-036, KBC-038]
---

# KBC-064 — Separar as vozes de uma gravação

## Story
Como quem edita as gravações, quero que o Mac do dono marque quando muda a voz que fala ("Voz 1", "Voz 2"…), para saber onde começa cada pergunta e cada resposta sem ouvir a gravação inteira.

## Scope
**In:** permissão nova `media-edit` ("Editar gravações: vozes, falantes e faixas"); ação "Separar vozes" na página do áudio (T15) para quem tem `media-edit`; trabalho novo `diarize` na fila (ADR 0022) feito pelo transcritor do Mac (ADR 0023), com o modelo escolhido no KBC-063; resultado bruto guardado ao lado do JSON da transcrição; turnos de fala derivados na API (`media_speaker_turns`) e cada segmento com a voz dominante; a transcrição ao lado (KBC-038) mostra "Voz N" na troca de voz, só para quem tem `media-edit`; refazer a separação cria uma versão nova.
**Out:** dar nome às vozes (KBC-065); reconhecer a mesma pessoa em outra gravação (KBC-071); mostrar vozes a quem só ouve (KBC-065, permissão `media-speakers`); separar vozes no servidor (proibido pela ADR 0022) ou no Groq.

## Business rules
- BR-1: a separação de vozes vale para uma gravação só: as vozes são números dentro dela; nenhuma impressão de voz (embedding) é guardada depois do trabalho (ADR 0029). Exceção: perfis de voz com consentimento (KBC-071).
- BR-2: a separação só começa a pedido de quem tem `media-edit` no acervo do áudio (ou de um master): marcada no envio ("Indicar quem está falando", KBC-072) ou pela página do áudio; nunca sem alguém pedir.
- BR-3: a separação usa a transcrição atual; se a transcrição muda de versão, a separação antiga continua visível com o aviso "Feita sobre uma transcrição anterior" até ser refeita.
- BR-4: o número de vozes é estimado pelo modelo, entre 1 e 10; quem pede pode informar "número de vozes" (1 a 10) para ajudar.
- BR-5: separação e transcrição nunca rodam ao mesmo tempo no mesmo Mac (um trabalho por vez, ADR 0023).

## Functional requirements
- FR-1: Quando alguém com `media-edit` aciona "Separar vozes", o sistema deve criar um trabalho `diarize` e mostrar "Aguardando o transcritor", "Separando vozes" e "Vozes separadas: N" como na transcrição. (BR-2)
- FR-2: O transcritor deve reservar trabalhos `diarize` (se pareado com esse tipo), baixar o FLAC 16 kHz, separar as vozes e enviar os turnos brutos (início, fim, voz) com a versão do modelo e dos parâmetros; nenhuma impressão de voz no envio. (BR-1, BR-4)
- FR-3: Ao receber o resultado, a API deve guardar o bruto, derivar os turnos e marcar em cada segmento a voz que fala a maior parte dele, e em cada palavra a voz do turno que a contém. (BR-3)
- FR-4: `GET /api/v1/media/{id}/transcript` deve incluir `speakers` (vozes e turnos) só para quem tem `media-edit`; para os outros, a resposta continua igual.
- FR-5: A transcrição ao lado deve mostrar o rótulo "Voz N" no primeiro segmento de cada troca de voz, com cor e forma (não só cor) distintas por voz.
- FR-6: "Transcritores" (KBC-036) deve permitir marcar se o transcritor faz `diarize`.

## Non-functional requirements
- NFR-1: erro de diarização (DER) ≤ 15 % nas 2 gravações de teste do KBC-063, medido com o script do relatório.
- NFR-2: tempo de máquina no Mac ≤ 5 min por hora de áudio (o KBC-063 confirma o valor do modelo escolhido).
- NFR-3: depois do trabalho, nenhum arquivo de embedding fica no Mac nem na API (verificado no teste do transcritor).

## Acceptance criteria
- **AC-1** (FR-1, FR-2, FR-3): Given uma palestra transcrita com perguntas da plateia e o transcritor ligado, When quem edita aciona "Separar vozes", Then o status passa por "Separando vozes" a "Vozes separadas: 3" e a transcrição mostra "Voz 1", "Voz 2", "Voz 3" nas trocas.
- **AC-2** (BR-2, permissão): Given uma pessoa só com `media`, When abre o mesmo áudio, Then não vê "Separar vozes" nem os rótulos, e `POST …/diarize` responde 403.
- **AC-3** (BR-1, NFR-3): Given o trabalho concluído, When o teste do transcritor procura arquivos de embedding no diretório de trabalho e o banco é consultado, Then não há nenhum.
- **AC-4** (BR-3): Given vozes separadas, When a transcrição é refeita (KBC-040), Then os rótulos continuam com o aviso "Feita sobre uma transcrição anterior" e "Separar vozes" vira "Separar vozes de novo".
- **AC-5** (BR-4, limite): Given uma gravação de uma voz só, When separada, Then o resultado é "Vozes separadas: 1" e nenhum rótulo extra aparece.
- **AC-6** (BR-4): Given "número de vozes: 2" informado, When separada uma conversa a dois, Then o resultado tem exatamente 2 vozes.
- **AC-7** (FR-2, negativo): Given o Mac desligado no meio do trabalho, When a reserva vence, Then o trabalho volta à fila e é concluído uma vez só (mesma regra da ADR 0022).
- **AC-9** (FR-6, negativo): Given um transcritor pareado sem o tipo `diarize`, When há um trabalho `diarize` na fila, Then ele não o reserva e a mídia mostra "Nenhum transcritor separa vozes; marque em Transcritores".
- **AC-8** (FR-5, acessibilidade): rótulos com texto "Voz N" lidos pelo leitor de tela, contraste AA nos três temas, sem violações sérias do axe em 1440 e 390 px.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1, AC-7 | integração (API + transcritor falso) + 1 execução manual no Mac | o falso devolve turnos de fixture |
| AC-2 | integração + E2E | duas contas |
| AC-3 | pytest no `tools/transcriber` | modelo falso que gravaria embeddings num diretório temporário |
| AC-4, AC-5, AC-6, AC-9 | integração | fixtures de turnos |
| AC-8 | E2E | axe |
| NFR-1, NFR-2 | manual na validação local | script do KBC-063 |

## References
ADR 0022, 0023, [0029](../adr/0029-recording-edits-speakers-tracks-and-subjects.md) · Tela T15 (transcrição ao lado, KBC-038); o progresso desta etapa ("Vozes achadas: N") aparece na T20 em modo preparação (KBC-072) · Pesquisa: KBC-063

## Decisões assumidas (o dono pode mudar)
- Separar vozes de uma gravação, sem guardar impressão de voz e sem ligar a voz a uma pessoa, é tratado como análise do áudio, não como identificação biométrica; a política de privacidade (T11) ganha uma frase dizendo isso.

## Open questions
Nenhuma.

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [x] UI and architecture references linked
- [x] Dependencies scheduled (KBC-063 primeiro); no open questions
- [x] Fits one goal
