---
id: KBC-079
title: "\"Onde processar\" por etapa: ordem de locais (computador pareado, servidor, GPU alugada, provedor), reserva automática, estimativa de custo e tetos, numa tela de configuração"
status: draft
slice: phase-3-server-processing
outcome: um master troca, pela tela, onde cada etapa roda sem mexer em código; com o Mac desligado, os trabalhos seguem para o próximo local permitido em ≤ N horas (padrão 12), dentro dos tetos
depends_on: [KBC-078, KBC-036, KBC-037, KBC-064]
---

# KBC-079 — "Onde processar" por etapa

## Story
Como master, quero escolher, para cada etapa do processamento (transcrever, separar vozes, impressões de voz, propor faixas, classificar), onde ela roda e o que fazer quando esse local está parado, vendo o custo estimado, para o acervo não depender do Mac do dono.

## Scope
**In:** permissão nova `media-processing-settings` ("Configurar onde processar a mídia"; masters por padrão); tela "Processamento" (Configurações, só para quem tem a permissão) com uma linha por etapa: lista ordenada de locais (arrastar ou setas), "passar para o próximo depois de N horas", custo estimado por hora de áudio de cada local e tetos; tabela `media_processing_settings` no `media.db` com versão, quem e quando; o despachante na API que escolhe o local de cada trabalho ao entrar na fila e a cada verificação de reserva; os locais existentes ligados a ele (computador pareado, Groq do KBC-037, IA da aplicação); os outros locais aparecem como "Ainda não disponível" até os seus itens; estimativa do passo 1 do envio (KBC-072) passa a usar o local que vai rodar; o modo do KBC-037 ("Nunca", "Só quando eu pedir", "Parado há N horas") vira esta configuração, migrado sem mudar o comportamento.
**Out:** os adaptadores novos (KBC-080 a KBC-085); tetos por pessoa e por acervo e fila justa (KBC-086); alertas e painel de saúde (KBC-087); a regra de privacidade (KBC-078, que este item respeita).

## Business rules
- BR-1: os padrões reproduzem a fase 2: `transcribe` = [computador pareado], `diarize` = [computador pareado], `voice-embedding` = [computador pareado], `propose` e `classify` = [IA da aplicação]; nada que custe dinheiro entra sozinho na lista.
- BR-2: um local só recebe um trabalho se for permitido pela privacidade do acervo (KBC-078) e se couber nos tetos (reserva antes de sair, ADR 0022 §7).
- BR-3: o servidor (VM) nunca aparece como local de `transcribe` (piloto: lento e erra nomes).
- BR-4: `voice-embedding` só aceita servidor e computador pareado (ADR 0031 §3).
- BR-5: o próximo local da lista só é usado quando o atual não reservou o trabalho em N horas (N de 1 a 168, padrão 12) ou quando o atual recusa (falha permanente, teto); um trabalho nunca roda em dois locais ao mesmo tempo.
- BR-6: um "Processar agora em <local>" manual numa mídia vale só para ela, respeitando BR-2.
- BR-7: toda mudança da configuração gera uma versão nova com quem e quando; a tela mostra as 10 últimas.

## Functional requirements
- FR-1: `GET/PUT /api/v1/media/processing-settings` devem ler e gravar, por etapa, `locations` (lista ordenada) e `fallbackAfterHours`; sem a permissão, 403; local proibido para a etapa (BR-3, BR-4), 422 com o motivo. (BR-3, BR-4, BR-7)
- FR-2: Quando um trabalho entra na fila, o despachante deve marcar os locais que podem reservá-lo (o primeiro permitido) e, a cada minuto, avançar para o próximo os que passaram de N horas sem reserva. (BR-2, BR-5)
- FR-3: A reserva de um worker só deve entregar trabalhos cujo local permitido inclui o worker (computador pareado ou servidor); os adaptadores de provedor na VM pegam só os que estão no local deles.
- FR-4: A tela deve mostrar, por local, custo estimado por hora de áudio ("grátis", "≈ US$ 0,04/h"), o estado (online há 3 min, parado desde…) e o gasto do mês com mídia e o teto.
- FR-5: A página do áudio deve mostrar onde cada etapa rodou ("Transcrito no Mac do Diogo", "Transcrito pelo Groq") e, para masters, "Processar agora em…". (BR-6)
- FR-6: A estimativa do passo 1 do envio deve vir do primeiro local permitido de cada etapa para o acervo escolhido.
- FR-7: A migração deve converter o modo do Groq (KBC-037) na configuração equivalente ("Nunca" → só computador pareado; "Parado há N horas" → [computador pareado, Groq] com N).

## Non-functional requirements
- NFR-1: o despachante decide um trabalho em ≤ 10 ms p95 com 5.000 trabalhos na fila (teste de carga no SQLite de integração).
- NFR-2: 0 trabalhos executados em dois locais em 1.000 execuções com relógio falso e reservas que vencem (teste de propriedade).

## Acceptance criteria
- **AC-1** (BR-1, FR-7): Given a configuração antiga do Groq em "Nunca", When a versão nova sobe, Then a tela mostra `transcribe` = [Computador pareado] e nada mais muda.
- **AC-2** (FR-2, BR-5): Given `transcribe` = [Computador pareado, Groq] com N = 12 e um acervo que permite, When um trabalho fica 12 h sem reserva, Then ele passa ao Groq e a mídia mostra "Transcrito pelo Groq".
- **AC-3** (BR-2, negativo): Given a mesma configuração e um acervo `Não` (KBC-078), When passam 12 h, Then o trabalho continua esperando com o motivo da privacidade.
- **AC-4** (BR-3, BR-4, FR-1): Given a tela, When um master tenta pôr "Servidor" em `transcribe` ou "Groq" em `voice-embedding`, Then o local aparece desativado com o motivo e o `PUT` direto responde 422.
- **AC-5** (permissão): Given uma pessoa sem `media-processing-settings`, When abre Configurações, Then não vê "Processamento" e o `GET` responde 403.
- **AC-6** (BR-5, NFR-2): Given um trabalho reservado pelo Mac que some, When a reserva vence e N passou, Then o trabalho vai ao próximo local e roda uma vez só.
- **AC-7** (FR-6): Given `transcribe` = [Groq] para um acervo que permite, When a pessoa escolhe um arquivo de 1 h no envio, Then a estimativa diz "≈ US$ 0,04, descontado do limite mensal da mídia".
- **AC-8** (BR-6, FR-5): Given uma mídia esperando o Mac, When um master clica "Processar agora em Groq" num acervo que permite, Then só essa mídia vai ao Groq.
- **AC-9** (BR-2, teto): Given US$ 9,99 gastos de US$ 10, When o despachante passaria um trabalho de 1 h ao Groq, Then ele não sai e a mídia mostra "Teto mensal de mídia atingido".
- **AC-10** (BR-7): Given 3 mudanças, When o master abre o histórico, Then vê as 3 com quem e quando.
- **AC-11**: tela "Processamento" em 1440 px e 390 px nos três temas, reordenar pelo teclado, sem violações sérias do axe.

## Test strategy
| AC | Nível | Notas |
|---|---|---|
| AC-1 | integração | migração sobre um banco com a configuração antiga |
| AC-2, AC-3, AC-6, AC-9 | integração | relógio falso, worker e provedor falsos |
| AC-4, AC-5, AC-10 | integração + E2E | duas contas |
| AC-7, AC-8 | E2E | arquivo de 1 h gerado por ffmpeg |
| AC-11 | E2E | axe, teclado |
| NFR-1, NFR-2 | integração / propriedade | fast-check |

## References
ADR: [0031](../adr/0031-processing-location-per-step.md) (§1, §5), [0022](../adr/0022-media-library-store-queue-and-streaming.md) (fila e teto), [0023](../adr/0023-transcription-pull-worker-on-the-owners-mac.md) · Itens: KBC-037, KBC-072, KBC-078 · Tela: "Processamento" a especificar com o `product-designer` (T20 proposta)

## Open questions
- Quem pode mudar "Onde processar"? Padrão recomendado: só quem tem `media-processing-settings`, dada só a masters por padrão. — owner: dono
- N padrão para passar ao próximo local? Padrão recomendado: 12 h, como o KBC-037. — owner: dono

## Definition of ready
- [x] Story, scope and outcome stated
- [x] Every BR and FR covered by at least one AC; negative and edge cases present
- [x] NFRs measurable
- [x] Test level chosen for every AC
- [ ] UI and architecture references linked (ADR 0031 proposta; tela T20 a especificar)
- [ ] Dependencies done or scheduled; no open questions
- [x] Fits one goal
